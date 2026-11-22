'use strict';
// 外部連携API のテスト: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createExternalApi } = require('../external-api');

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const CH_A = '333333333333333333'; // A のテキストチャンネル
const CH_B = '444444444444444444'; // B のテキストチャンネル
const VC_A = '555555555555555555';
const USER = '666666666666666666';

/** 号機の代わり。enqueue された音声(Buffer)を記録する */
function fakeBot(guildId, channelIds, vcId) {
  const played = [];
  return {
    played,
    guilds: new Map(guildId ? [[guildId, { channelIds: new Set(channelIds) }]] : []),
    vconn: () => ({ joinConfig: { channelId: vcId } }),
    enqueue: (gid, wav) => played.push({ gid, text: wav.toString() }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(5); }
  throw new Error('タイムアウト');
}

/** API + HTTPサーバーを立てる。ctx.call(method, path, {token, body, headers}) で呼ぶ */
async function setup({ bots = [], options = {}, synthesize, prepareItem } = {}) {
  const settings = { users: {}, guilds: {} };
  const logs = [];
  let clock = 1_000_000;
  const api = createExternalApi({
    settings,
    save: () => { settings.saved = (settings.saved || 0) + 1; },
    bots,
    // 本物と同じく、依頼1件を「文章・声・速度」にする (ここでは、渡された値をそのまま使う)
    prepareItem: prepareItem || (async (gid, item) => ({ text: item.text, speaker: item.voice_id ?? 3, speed: item.speed ?? 1 })),
    synthesize: synthesize || (async (text, speaker, speed) => Buffer.from(`${speaker}/${speed}/${text}`)),
    guildName: (gid) => ({ [GUILD_A]: 'サーバーA', [GUILD_B]: 'サーバーB' }[gid] ?? null),
    version: '9.9.9',
    log: (m) => logs.push(m),
    options: { now: () => clock, ...options },
  });
  const server = http.createServer((req, res) => {
    api.handle(req, res).then((h) => { if (!h) res.writeHead(404).end('static'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, { token, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 本文がJSONでない */ }
    return { status: res.status, json, headers: res.headers, text };
  }
  return {
    api, settings, logs, call, advance: (ms) => { clock += ms; },
    close: async () => { api.close(); await new Promise((r) => server.close(r)); },
  };
}

const speakBody = (over = {}) => ({ channel_id: CH_A, items: [{ text: 'お題。猫が会議で言った一言は?' }], source: 'lumi:ogiri', ...over });

// ---------------------------------------------------------------- トークン
test('トークン: shb2_ + base64url(32バイト以上)で、DBにはSHA-256ハッシュだけが保存される', async () => {
  const t = await setup();
  const { token } = t.api.enable(GUILD_A);
  assert.match(token, /^shb2_[A-Za-z0-9_-]{43,}$/);
  const stored = t.settings.guilds[GUILD_A].external;
  assert.equal(stored.enabled, true);
  assert.equal(stored.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(t.settings).includes(token), '平文のトークンが保存されている');
  assert.notEqual(t.api.generateToken(), t.api.generateToken());
  await t.close();
});

test('トークン: 照合できる。他人のトークン・でたらめ・形式違いは無効', async () => {
  const t = await setup();
  const a = t.api.enable(GUILD_A).token;
  const b = t.api.enable(GUILD_B).token;
  assert.equal(t.api.verifyToken(a), GUILD_A);
  assert.equal(t.api.verifyToken(b), GUILD_B);
  assert.equal(t.api.verifyToken(a + 'x'), null);
  assert.equal(t.api.verifyToken('shb2_' + 'A'.repeat(43)), null);
  assert.equal(t.api.verifyToken('not-a-token'), null);
  assert.equal(t.api.verifyToken(undefined), null);
  assert.equal(t.api.verifyToken('shb2_' + 'x'.repeat(500)), null);
  await t.close();
});

test('on: すでにオンなら、トークンを再表示しない(already)', async () => {
  const t = await setup();
  const first = t.api.enable(GUILD_A);
  assert.ok(first.token);
  const second = t.api.enable(GUILD_A);
  assert.deepEqual(second, { already: true });
  assert.equal(t.api.verifyToken(first.token), GUILD_A, '最初のトークンはそのまま有効');
  await t.close();
});

test('regenerate: 新しいトークンが有効になり、古いトークンはすぐ無効になる', async () => {
  const t = await setup({ bots: [fakeBot(GUILD_A, [CH_A], VC_A)] });
  const old = t.api.enable(GUILD_A).token;
  assert.equal((await t.call('GET', '/api/v1/health', { token: old })).status, 200);
  const fresh = t.api.regenerate(GUILD_A).token;
  assert.notEqual(fresh, old);
  assert.equal((await t.call('GET', '/api/v1/health', { token: old })).status, 401);
  assert.equal((await t.call('GET', '/api/v1/health', { token: fresh })).status, 200);
  await t.close();
});

test('off: トークンが無効になり、ハッシュも消える。再度onにすると新しいトークンになる', async () => {
  const t = await setup();
  const old = t.api.enable(GUILD_A).token;
  t.api.disable(GUILD_A);
  assert.equal(t.api.isEnabled(GUILD_A), false);
  assert.equal(t.settings.guilds[GUILD_A].external.tokenHash, undefined);
  assert.equal((await t.call('GET', '/api/v1/health', { token: old })).status, 401);
  const again = t.api.enable(GUILD_A);
  assert.ok(again.token && again.token !== old);
  assert.equal((await t.call('GET', '/api/v1/health', { token: old })).status, 401, '古いトークンは復活しない');
  assert.equal((await t.call('GET', '/api/v1/health', { token: again.token })).status, 200);
  await t.close();
});

// ---------------------------------------------------------------- 認証
test('認証: 無効・不明・取り消し済み・ヘッダー無しは、すべて同じ401(理由を区別しない)', async () => {
  const t = await setup();
  const revoked = t.api.enable(GUILD_A).token;
  t.api.disable(GUILD_A);
  const cases = [
    {},                                                        // ヘッダー無し
    { token: 'shb2_' + crypto.randomBytes(32).toString('base64url') }, // でたらめ
    { token: revoked },                                         // 取り消し済み
    { headers: { Authorization: 'Basic abc' } },               // 方式違い
  ];
  const bodies = [];
  for (const c of cases) {
    const r = await t.call('GET', '/api/v1/health', c);
    assert.equal(r.status, 401);
    bodies.push(r.text);
  }
  assert.equal(new Set(bodies).size, 1, '失敗のレスポンスが、理由によって違う');
  await t.close();
});

test('認証失敗が続いたIPは、一時的にブロックされる(総当たり対策)。Retry-After付き', async () => {
  const t = await setup({ options: { authFailPerMin: 3 } });
  const good = t.api.enable(GUILD_A).token;
  for (let i = 0; i < 3; i++) assert.equal((await t.call('GET', '/api/v1/health', { token: 'shb2_bad' + i })).status, 401);
  const blocked = await t.call('GET', '/api/v1/health', { token: 'shb2_bad9' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal((await t.call('GET', '/api/v1/health', { token: good })).status, 429, 'ブロック中は正しいトークンも通さない');
  t.advance(61_000);
  assert.equal((await t.call('GET', '/api/v1/health', { token: good })).status, 200, '1分後に解除される');
  await t.close();
});

test('CF-Connecting-IP が違うIPは、別々に数える', async () => {
  const t = await setup({ options: { authFailPerMin: 2 } });
  const good = t.api.enable(GUILD_A).token;
  for (let i = 0; i < 2; i++) await t.call('GET', '/api/v1/health', { token: 'shb2_x', headers: { 'CF-Connecting-IP': '203.0.113.1' } });
  assert.equal((await t.call('GET', '/api/v1/health', { headers: { 'CF-Connecting-IP': '203.0.113.1' } })).status, 429);
  assert.equal((await t.call('GET', '/api/v1/health', { token: good, headers: { 'CF-Connecting-IP': '203.0.113.2' } })).status, 200);
  await t.close();
});

// ---------------------------------------------------------------- health / session
test('health: トークンが正しければ、guild_id・guild_name・version を返す', async () => {
  const t = await setup();
  const token = t.api.enable(GUILD_A).token;
  const r = await t.call('GET', '/api/v1/health', { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, guild_id: GUILD_A, guild_name: 'サーバーA', version: '9.9.9' });
  await t.close();
});

test('session: 読み上げ中なら active:true と号機番号・VCのID。そうでなければ active:false', async () => {
  const bot1 = fakeBot(null, [], null);
  const bot2 = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({ bots: [bot1, bot2] });
  const token = t.api.enable(GUILD_A).token;
  const on = await t.call('GET', `/api/v1/session?channel_id=${CH_A}`, { token });
  assert.deepEqual(on.json, { active: true, bot: 2, voice_channel_id: VC_A });
  const off = await t.call('GET', `/api/v1/session?channel_id=${CH_B}`, { token });
  assert.deepEqual(off.json, { active: false });
  assert.equal((await t.call('GET', '/api/v1/session', { token })).status, 400, 'channel_id が無い');
  await t.close();
});

test('session: 他のサーバーの読み上げ状況は見えない', async () => {
  const t = await setup({ bots: [fakeBot(GUILD_B, [CH_B], VC_A)] });
  const tokenA = t.api.enable(GUILD_A).token;
  const r = await t.call('GET', `/api/v1/session?channel_id=${CH_B}`, { token: tokenA });
  assert.deepEqual(r.json, { active: false });
  await t.close();
});

// ---------------------------------------------------------------- speak
test('speak: 読み上げ対象の号機のキューに入り、queued と号機番号を返す', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({ bots: [bot] });
  const token = t.api.enable(GUILD_A).token;
  const r = await t.call('POST', '/api/v1/speak', { token, body: speakBody({ items: [{ text: 'お題' }, { text: '回答', voice_id: 8, speed: 1.5 }] }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'queued', bot: 1, queued: 2 });
  await waitFor(() => bot.played.length === 2);
  assert.deepEqual(bot.played.map((p) => p.text), ['3/1/お題', '8/1.5/回答']);
  assert.ok(bot.played.every((p) => p.gid === GUILD_A));
  await t.close();
});

test('speak: 読み上げ対象にしている号機がなければ no_session(エラーではない)', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({ bots: [bot] });
  const token = t.api.enable(GUILD_A).token;
  const r = await t.call('POST', '/api/v1/speak', { token, body: speakBody({ channel_id: '999999999999999999' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'no_session' });
  await sleep(30);
  assert.equal(bot.played.length, 0);
  await t.close();
});

test('speak: 他のサーバーへは依頼できない(トークンのサーバーだけが対象)', async () => {
  const botA = fakeBot(GUILD_A, [CH_A], VC_A);
  const botB = fakeBot(GUILD_B, [CH_B], VC_A);
  const t = await setup({ bots: [botA, botB] });
  const tokenA = t.api.enable(GUILD_A).token;
  t.api.enable(GUILD_B);
  // A のトークンで、B のチャンネルを指定しても、B の号機は動かない
  const r = await t.call('POST', '/api/v1/speak', { token: tokenA, body: speakBody({ channel_id: CH_B }) });
  assert.deepEqual(r.json, { status: 'no_session' });
  await sleep(30);
  assert.equal(botB.played.length, 0);
  // body に guild_id を入れても無視される
  const r2 = await t.call('POST', '/api/v1/speak', { token: tokenA, body: { ...speakBody({ channel_id: CH_B }), guild_id: GUILD_B } });
  assert.deepEqual(r2.json, { status: 'no_session' });
  await sleep(30);
  assert.equal(botB.played.length, 0);
  // 自分のサーバーは読める
  const ok = await t.call('POST', '/api/v1/speak', { token: tokenA, body: speakBody() });
  assert.equal(ok.json.status, 'queued');
  await waitFor(() => botA.played.length === 1);
  await t.close();
});

test('speak: 同じチャンネルを複数の号機が対象にしていたら、1号機に近い方', async () => {
  const bot1 = fakeBot(GUILD_A, [CH_A], VC_A);
  const bot2 = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({ bots: [bot1, bot2] });
  const token = t.api.enable(GUILD_A).token;
  const r = await t.call('POST', '/api/v1/speak', { token, body: speakBody() });
  assert.equal(r.json.bot, 1);
  await waitFor(() => bot1.played.length === 1);
  assert.equal(bot2.played.length, 0);
  await t.close();
});

test('speak: 順番どおりに読み上げる(合成に時間がかかる項目があっても、依頼をまたいでも)', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const delays = { '1': 60, '2': 5, '3': 30, '4': 1, '5': 1 };
  const t = await setup({
    bots: [bot],
    synthesize: async (text) => { await sleep(delays[text] ?? 0); return Buffer.from(text); },
  });
  const token = t.api.enable(GUILD_A).token;
  const r1 = await t.call('POST', '/api/v1/speak', { token, body: speakBody({ items: [{ text: '1' }, { text: '2' }, { text: '3' }] }) });
  const r2 = await t.call('POST', '/api/v1/speak', { token, body: speakBody({ items: [{ text: '4' }, { text: '5' }] }) });
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  await waitFor(() => bot.played.length === 5);
  assert.deepEqual(bot.played.map((p) => p.text), ['1', '2', '3', '4', '5']);
  await t.close();
});

test('speak: 合成に失敗した項目は飛ばして、続きを読む。ログに本文を残さない', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({
    bots: [bot],
    synthesize: async (text) => { if (text === 'NG') throw new Error('TTS 500: ひみつの本文NG'); return Buffer.from(text); },
  });
  const token = t.api.enable(GUILD_A).token;
  await t.call('POST', '/api/v1/speak', { token, body: speakBody({ items: [{ text: 'a' }, { text: 'NG' }, { text: 'b' }] }) });
  await waitFor(() => bot.played.length === 2);
  assert.deepEqual(bot.played.map((p) => p.text), ['a', 'b']);
  await sleep(20);
  const log = t.logs.join('\n');
  assert.ok(log.includes(GUILD_A));
  assert.ok(!log.includes('ひみつの本文'), 'ログに本文が出ている');
  await t.close();
});

test('speak: ログには、サーバーIDと件数だけが残り、本文は残らない', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({ bots: [bot] });
  const token = t.api.enable(GUILD_A).token;
  await t.call('POST', '/api/v1/speak', { token, body: speakBody({ items: [{ text: '誰にも見せない回答' }, { text: 'もう一つ' }] }) });
  await waitFor(() => bot.played.length === 2);
  const log = t.logs.join('\n');
  assert.match(log, new RegExp(`guild=${GUILD_A} items=2`));
  assert.ok(!log.includes('誰にも見せない') && !log.includes('もう一つ'));
  await t.close();
});

test('speak: user_id / say_name / voice_id / speed は、準備処理に渡される', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const seen = [];
  const t = await setup({
    bots: [bot],
    prepareItem: async (gid, item) => { seen.push({ gid, ...item }); return { text: item.text, speaker: 1, speed: 1 }; },
  });
  const token = t.api.enable(GUILD_A).token;
  const item = { text: 'ニャーン会議', user_id: USER, say_name: true, voice_id: 8, speed: 1.2 };
  await t.call('POST', '/api/v1/speak', { token, body: speakBody({ items: [item] }) });
  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen[0], { gid: GUILD_A, ...item });
  await t.close();
});

// ---------------------------------------------------------------- Idempotency-Key
test('Idempotency-Key: 同じキーの依頼は、10分間は二重に読まない。10分たつと読める', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({ bots: [bot] });
  const token = t.api.enable(GUILD_A).token;
  const headers = { 'Idempotency-Key': 'req-1' };
  const r1 = await t.call('POST', '/api/v1/speak', { token, body: speakBody(), headers });
  assert.equal(r1.json.status, 'queued');
  await waitFor(() => bot.played.length === 1);
  const r2 = await t.call('POST', '/api/v1/speak', { token, body: speakBody(), headers });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json, r1.json, '前回と同じ応答を返す');
  assert.equal(r2.headers.get('idempotency-replayed'), 'true');
  await sleep(40);
  assert.equal(bot.played.length, 1, '二重に読んでいる');
  // 別のキーは読める
  await t.call('POST', '/api/v1/speak', { token, body: speakBody(), headers: { 'Idempotency-Key': 'req-2' } });
  await waitFor(() => bot.played.length === 2);
  // 10分後は、同じキーでも読める
  t.advance(10 * 60 * 1000 + 1);
  await t.call('POST', '/api/v1/speak', { token, body: speakBody(), headers });
  await waitFor(() => bot.played.length === 3);
  await t.close();
});

test('Idempotency-Key: キーはサーバーごとに分かれる', async () => {
  const botA = fakeBot(GUILD_A, [CH_A], VC_A);
  const botB = fakeBot(GUILD_B, [CH_B], VC_A);
  const t = await setup({ bots: [botA, botB] });
  const tokenA = t.api.enable(GUILD_A).token;
  const tokenB = t.api.enable(GUILD_B).token;
  const headers = { 'Idempotency-Key': 'same' };
  await t.call('POST', '/api/v1/speak', { token: tokenA, body: speakBody(), headers });
  await t.call('POST', '/api/v1/speak', { token: tokenB, body: speakBody({ channel_id: CH_B }), headers });
  await waitFor(() => botA.played.length === 1 && botB.played.length === 1);
  await t.close();
});

// ---------------------------------------------------------------- 制限・検証
test('レート制限: 1トークンあたり1分N回まで。超えると429とRetry-After。他サーバーには影響しない。1分後に回復', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({ bots: [bot], options: { ratePerMin: 3 } });
  const tokenA = t.api.enable(GUILD_A).token;
  const tokenB = t.api.enable(GUILD_B).token;
  for (let i = 0; i < 3; i++) assert.equal((await t.call('GET', '/api/v1/health', { token: tokenA })).status, 200);
  const limited = await t.call('GET', '/api/v1/health', { token: tokenA });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await t.call('GET', '/api/v1/health', { token: tokenB })).status, 200, '別のサーバーは制限されない');
  t.advance(60_001);
  assert.equal((await t.call('GET', '/api/v1/health', { token: tokenA })).status, 200);
  await t.close();
});

test('レート制限: 既定は1分に60回まで', async () => {
  const t = await setup();
  const token = t.api.enable(GUILD_A).token;
  for (let i = 0; i < 60; i++) assert.equal((await t.call('GET', '/api/v1/health', { token })).status, 200, `${i + 1}回目`);
  assert.equal((await t.call('GET', '/api/v1/health', { token })).status, 429);
  await t.close();
});

test('検証: 形式が不正なら400、長すぎれば413', async () => {
  const bot = fakeBot(GUILD_A, [CH_A], VC_A);
  const t = await setup({ bots: [bot] });
  const token = t.api.enable(GUILD_A).token;
  const post = (body, raw) => t.call('POST', '/api/v1/speak', { token, body, raw });
  const many = (n) => Array.from({ length: n }, (_, i) => ({ text: `t${i}` }));

  assert.equal((await post(undefined, '{ broken')).status, 400, 'JSONが壊れている');
  assert.equal((await post(undefined, '[]')).status, 400, '配列');
  assert.equal((await post(speakBody({ channel_id: undefined }))).status, 400, 'channel_id なし');
  assert.equal((await post(speakBody({ channel_id: 'abc' }))).status, 400, 'channel_id が数字でない');
  assert.equal((await post(speakBody({ items: [] }))).status, 400, 'items が空');
  assert.equal((await post(speakBody({ items: 'x' }))).status, 400, 'items が配列でない');
  assert.equal((await post(speakBody({ items: [{ text: '' }] }))).status, 400, 'text が空');
  assert.equal((await post(speakBody({ items: [{ text: '   ' }] }))).status, 400, 'text が空白だけ');
  assert.equal((await post(speakBody({ items: [{ text: 1 }] }))).status, 400, 'text が文字列でない');
  assert.equal((await post(speakBody({ items: [{ text: 'a', user_id: 'x' }] }))).status, 400, 'user_id が不正');
  assert.equal((await post(speakBody({ items: [{ text: 'a', say_name: 'yes' }] }))).status, 400, 'say_name が真偽値でない');
  assert.equal((await post(speakBody({ items: [{ text: 'a', speed: 0.4 }] }))).status, 400, 'speed が小さすぎる');
  assert.equal((await post(speakBody({ items: [{ text: 'a', speed: 2.1 }] }))).status, 400, 'speed が大きすぎる');
  assert.equal((await post(speakBody({ items: [{ text: 'a', voice_id: 1.5 }] }))).status, 400, 'voice_id が整数でない');
  assert.equal((await post(speakBody({ items: [{ text: 'a' }, { text: '' }] }))).status, 400, '2件目が不正なら、全体を受け付けない');

  assert.equal((await post(speakBody({ items: many(21) }))).status, 413, '21件');
  assert.equal((await post(speakBody({ items: [{ text: 'あ'.repeat(501) }] }))).status, 413, '501文字');

  // 境界: 20件・500文字・speed 0.5/2.0 は通る
  assert.equal((await post(speakBody({ items: many(20) }))).status, 200);
  assert.equal((await post(speakBody({ items: [{ text: 'あ'.repeat(500), speed: 0.5 }, { text: 'a', speed: 2.0 }] }))).status, 200);
  await t.close();
});

test('検証: 64KBを超えるボディは413', async () => {
  const t = await setup({ bots: [fakeBot(GUILD_A, [CH_A], VC_A)] });
  const token = t.api.enable(GUILD_A).token;
  const huge = JSON.stringify(speakBody({ source: 'x', items: [{ text: 'a' }], pad: 'x'.repeat(70 * 1024) }));
  assert.ok(huge.length > 64 * 1024);
  const r = await t.call('POST', '/api/v1/speak', { token, raw: huge, headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 413);
  await t.close();
});

test('ルーティング: 未知のパスは404、メソッド違いは405、/api/v1 以外は処理しない', async () => {
  const t = await setup();
  const token = t.api.enable(GUILD_A).token;
  assert.equal((await t.call('GET', '/api/v1/nope', { token })).status, 404);
  assert.equal((await t.call('GET', '/api/v1/speak', { token })).status, 405);
  assert.equal((await t.call('POST', '/api/v1/health', { token })).status, 405);
  const other = await t.call('GET', '/');
  assert.equal(other.status, 404);
  assert.equal(other.text, 'static', '/api/v1 以外はサイト側に回す');
  await t.close();
});

// ---------------------------------------------------------------- プロキシ配下 (Railway など)
test('trustProxy: X-Forwarded-For の末尾を接続元として数える(先頭は偽装できるので使わない)', async () => {
  const t = await setup({ options: { trustProxy: true, authFailPerMin: 2 } });
  const good = t.api.enable(GUILD_A).token;
  // 攻撃者が XFF の先頭を毎回変えても、プロキシが付けた末尾(203.0.113.9)で数えられ、ブロックされる
  for (let i = 0; i < 2; i++) {
    await t.call('GET', '/api/v1/health', { token: 'shb2_bad', headers: { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9` } });
  }
  const blocked = await t.call('GET', '/api/v1/health', { token: good, headers: { 'X-Forwarded-For': '10.9.9.9, 203.0.113.9' } });
  assert.equal(blocked.status, 429);
  // 別のIP(プロキシが付けた末尾が違う)は影響を受けない
  const other = await t.call('GET', '/api/v1/health', { token: good, headers: { 'X-Forwarded-For': '10.9.9.9, 203.0.113.77' } });
  assert.equal(other.status, 200);
  await t.close();
});

test('trustProxy がオフなら、X-Forwarded-For は無視する(偽装でブロックを逃れられない)', async () => {
  const t = await setup({ options: { trustProxy: false, authFailPerMin: 2 } });
  const good = t.api.enable(GUILD_A).token;
  for (let i = 0; i < 2; i++) {
    await t.call('GET', '/api/v1/health', { token: 'shb2_bad', headers: { 'X-Forwarded-For': `198.51.100.${i}` } });
  }
  const r = await t.call('GET', '/api/v1/health', { token: good, headers: { 'X-Forwarded-For': '198.51.100.200' } });
  assert.equal(r.status, 429, 'XFFを変えても、同じ接続元として数える');
  await t.close();
});
