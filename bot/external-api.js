'use strict';
// 外部連携API (/api/v1): 他のBOT(Lumi など)から、HTTPで読み上げを依頼できるようにする。
//   - 認証: サーバーごとのトークン (Authorization: Bearer shb2_...)。DBにはSHA-256ハッシュだけを保存する。
//   - エンドポイント: POST /speak, GET /session, GET /health
// BOT本体には依存せず、必要なものは createExternalApi の引数で受け取る (テストしやすくするため)。

const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const SNOWFLAKE = /^\d{5,25}$/;

/**
 * @param {object} deps
 * @param {{guilds: object}} deps.settings  設定(保存対象)。settings.guilds[guildId].external に状態を持つ
 * @param {() => void} [deps.save]          設定を保存する
 * @param {Array<{guilds: Map, vconn: Function, enqueue: Function}>} deps.bots  号機のリスト(1号機が先頭)
 * @param {(guildId: string, item: object) => Promise<{text: string, speaker: number, speed: number}>} deps.prepareItem
 *        依頼1件を、読み上げる文章・声・速度に変換する (整形・辞書・本人の声の解決)
 * @param {(text: string, speaker: number, speed: number) => Promise<Buffer>} deps.synthesize
 * @param {(guildId: string) => string|null} [deps.guildName]
 * @param {string} [deps.version]
 * @param {(msg: string) => void} [deps.log]
 * @param {object} [deps.options]  テスト用に上書きできる制限値
 */
function createExternalApi(deps) {
  const { settings, save = () => {}, bots, prepareItem, synthesize, guildName = () => null, version = '0.0.0', log = () => {} } = deps;
  const opt = {
    ratePerMin: 60,            // 1トークン(=1サーバー)あたりのリクエスト数/分
    authFailPerMin: 10,        // 認証に失敗できる回数/分/IP (超えるとそのIPを1分間ブロック)
    bodyLimit: 64 * 1024,      // リクエストボディの上限
    idempotencyMs: 10 * 60 * 1000,
    now: Date.now,
    trustProxy: false,         // true: X-Forwarded-For の末尾(=手前のプロキシが付けたIP)を、接続元として使う (Railway など)
    ...(deps.options || {}),
  };
  settings.guilds ||= {};

  // ---------- トークン管理 ----------
  const cfg = (guildId) => settings.guilds[guildId]?.external;
  const generateToken = () => 'shb2_' + crypto.randomBytes(32).toString('base64url');

  function issue(guildId) {
    const token = generateToken();
    const g = (settings.guilds[guildId] ||= {});
    g.external = { enabled: true, tokenHash: sha256(token).toString('hex'), createdAt: new Date(opt.now()).toISOString() };
    save();
    return token;
  }
  /** オンにする。すでにオンなら { already: true } (トークンは再表示しない) */
  function enable(guildId) {
    if (cfg(guildId)?.enabled) return { already: true };
    return { token: issue(guildId) };
  }
  /** 新しいトークンを発行する。古いトークンは、すぐ無効になる */
  function regenerate(guildId) { return { token: issue(guildId) }; }
  /** 外部連携を止める。トークン(のハッシュ)も消す */
  function disable(guildId) {
    if (settings.guilds[guildId]?.external) { settings.guilds[guildId].external = { enabled: false }; save(); }
  }
  const isEnabled = (guildId) => !!cfg(guildId)?.enabled;

  /** トークンから guildId を決める。一定時間で比較し、途中で打ち切らない。無効なら null */
  function verifyToken(token) {
    if (typeof token !== 'string' || !token.startsWith('shb2_') || token.length > 200) return null;
    const h = sha256(token);
    let found = null;
    for (const [gid, g] of Object.entries(settings.guilds)) {
      const e = g?.external;
      if (!e?.enabled || !e.tokenHash) continue;
      const stored = Buffer.from(e.tokenHash, 'hex');
      if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) found = gid;
    }
    return found;
  }

  // ---------- 回数制限 ----------
  const rate = new Map();     // guildId -> { count, resetAt }
  const authFails = new Map(); // ip -> { count, resetAt }
  const idem = new Map();      // `${guildId}\n${key}` -> { at, body }

  function windowHit(map, key, limit) {
    const now = opt.now();
    let w = map.get(key);
    if (!w || now >= w.resetAt) { w = { count: 0, resetAt: now + 60_000 }; map.set(key, w); }
    w.count += 1;
    return { ok: w.count <= limit, retryAfter: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }
  function ipBlocked(ip) {
    const w = authFails.get(ip);
    const now = opt.now();
    if (!w || now >= w.resetAt) return 0;
    return w.count >= opt.authFailPerMin ? Math.max(1, Math.ceil((w.resetAt - now) / 1000)) : 0;
  }
  const sweep = setInterval(() => {
    const now = opt.now();
    for (const [k, w] of rate) if (now >= w.resetAt) rate.delete(k);
    for (const [k, w] of authFails) if (now >= w.resetAt) authFails.delete(k);
    for (const [k, v] of idem) if (now - v.at >= opt.idempotencyMs) idem.delete(k);
  }, 60_000);
  sweep.unref?.();

  // ---------- 号機・セッション ----------
  /** channelId を読み上げ対象にしている号機。複数なら1号機に近い方 */
  function findSession(guildId, channelId) {
    for (let i = 0; i < bots.length; i++) {
      const st = bots[i].guilds.get(guildId);
      if (st && st.channelIds.has(channelId)) return { bot: bots[i], index: i, state: st };
    }
    return null;
  }

  /** 依頼を、順番どおりに合成してキューへ入れる (同じ号機・サーバーへの依頼は、前の依頼が終わってから) */
  function queueItems(guildId, session, items) {
    const { bot, state } = session;
    const task = async () => {
      for (const item of items) {
        try {
          const { text, speaker, speed } = await prepareItem(guildId, item);
          if (!text) continue;
          bot.enqueue(guildId, await synthesize(text, speaker, speed));
        } catch (e) {
          // 本文が含まれうるので、エラーの詳細(コロン以降)はログに残さない
          log(`[api] 読み上げ失敗 guild=${guildId}: ${String(e?.message || e).split(':')[0].slice(0, 40)}`);
        }
      }
    };
    state.apiChain = (state.apiChain || Promise.resolve()).then(task, task);
    return state.apiChain;
  }

  // ---------- HTTP ----------
  function send(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(data);
  }
  // 接続元IP。Cloudflare 経由なら CF-Connecting-IP。プロキシ配下(trustProxy)なら X-Forwarded-For の末尾
  // (末尾は手前のプロキシが付けた値で、クライアントは偽装できない。先頭は偽装できるので使わない)
  const clientIp = (req) => {
    if (req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']);
    if (opt.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return String(req.socket?.remoteAddress || 'unknown');
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > opt.bodyLimit) return reject(Object.assign(new Error('too large'), { status: 413 }));
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > opt.bodyLimit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy?.(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** 依頼の検証。問題があれば { status, error } を返す */
  function validateSpeak(b) {
    const bad = (error) => ({ status: 400, error });
    if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('invalid_body');
    if (typeof b.channel_id !== 'string' || !SNOWFLAKE.test(b.channel_id)) return bad('invalid_channel_id');
    if (!Array.isArray(b.items) || b.items.length < 1) return bad('invalid_items');
    if (b.items.length > 20) return { status: 413, error: 'too_many_items' };
    if (b.source !== undefined && (typeof b.source !== 'string' || b.source.length > 64)) return bad('invalid_source');
    for (const it of b.items) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return bad('invalid_item');
      if (typeof it.text !== 'string' || it.text.trim().length < 1) return bad('invalid_text');
      if (it.text.length > 500) return { status: 413, error: 'text_too_long' };
      if (it.user_id !== undefined && (typeof it.user_id !== 'string' || !SNOWFLAKE.test(it.user_id))) return bad('invalid_user_id');
      if (it.say_name !== undefined && typeof it.say_name !== 'boolean') return bad('invalid_say_name');
      if (it.voice_id !== undefined && (!Number.isInteger(it.voice_id) || it.voice_id < 0 || it.voice_id > 99999)) return bad('invalid_voice_id');
      if (it.speed !== undefined && (typeof it.speed !== 'number' || !(it.speed >= 0.5 && it.speed <= 2.0))) return bad('invalid_speed');
    }
    return null;
  }

  /** /api/v1 の処理。このAPIの担当パスなら true を返す (担当でなければ false) */
  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== '/api/v1' && !p.startsWith('/api/v1/')) return false;

    const route = p.slice('/api/v1'.length);
    const allowed = { '/health': 'GET', '/session': 'GET', '/speak': 'POST' }[route];
    if (!allowed) { send(res, 404, { error: 'not_found' }); return true; }
    if (req.method !== allowed) { send(res, 405, { error: 'method_not_allowed' }, { Allow: allowed }); return true; }

    // 認証 (失敗の理由は区別しない: トークンの有無・サーバーの存在を推測させない)
    const ip = clientIp(req);
    const blocked = ipBlocked(ip);
    if (blocked) { send(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(blocked) }); return true; }
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    const guildId = m ? verifyToken(m[1]) : null;
    if (!guildId) {
      windowHit(authFails, ip, Infinity);
      send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return true;
    }
    const lim = windowHit(rate, guildId, opt.ratePerMin);
    if (!lim.ok) { send(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(lim.retryAfter) }); return true; }

    try {
      if (route === '/health') {
        send(res, 200, { ok: true, guild_id: guildId, guild_name: guildName(guildId), version });
        return true;
      }

      if (route === '/session') {
        const channelId = url.searchParams.get('channel_id') || '';
        if (!SNOWFLAKE.test(channelId)) { send(res, 400, { error: 'invalid_channel_id' }); return true; }
        const s = findSession(guildId, channelId);
        send(res, 200, s
          ? { active: true, bot: s.index + 1, voice_channel_id: s.bot.vconn(guildId)?.joinConfig?.channelId ?? null }
          : { active: false });
        return true;
      }

      // POST /speak
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) {
        if (e.status === 413) { send(res, 413, { error: 'body_too_large' }); return true; }
        send(res, 400, { error: 'invalid_json' });
        return true;
      }
      const invalid = validateSpeak(body);
      if (invalid) { send(res, invalid.status, { error: invalid.error }); return true; }

      const key = req.headers['idempotency-key'];
      const idemKey = typeof key === 'string' && key && key.length <= 200 ? `${guildId}\n${key}` : null;
      if (idemKey) {
        const hit = idem.get(idemKey);
        if (hit && opt.now() - hit.at < opt.idempotencyMs) { send(res, 200, hit.body, { 'Idempotency-Replayed': 'true' }); return true; }
      }

      const session = findSession(guildId, body.channel_id);
      if (!session) { send(res, 200, { status: 'no_session' }); return true; }

      const result = { status: 'queued', bot: session.index + 1, queued: body.items.length };
      if (idemKey) idem.set(idemKey, { at: opt.now(), body: result });
      log(`[api] speak guild=${guildId} items=${body.items.length}`); // 本文は残さない
      queueItems(guildId, session, body.items);
      send(res, 200, result);
      return true;
    } catch (e) {
      log(`[api] error guild=${guildId}: ${String(e?.message || e).split(':')[0].slice(0, 40)}`);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
      return true;
    }
  }

  return { handle, enable, regenerate, disable, isEnabled, verifyToken, findSession, generateToken, close: () => clearInterval(sweep) };
}

module.exports = { createExternalApi };
