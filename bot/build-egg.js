// コード(index.js ほか)・package.json・サイトを埋め込んだ Pterodactyl egg を生成する: node build-egg.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pkg = fs.readFileSync('package.json', 'utf8');
const idxSrc = fs.readFileSync('index.js', 'utf8');

// ../site の全ファイルを gzip→base64 にして index.js の SITE_BUNDLE に埋め込む (サイトもBOT本体の一部になる)
function readSite(dir, base = '') {
  const out = {};
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) Object.assign(out, readSite(dir, rel));
    else out[rel] = zlib.gzipSync(fs.readFileSync(path.join(dir, rel)), { level: 9 }).toString('base64');
  }
  return out;
}
const bundle = readSite(path.resolve('..', 'site'));
const buildId = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T'); // 例: 2026-11-15T19:30:00 (日本時間)
const idx = idxSrc
  .replace('const SITE_BUNDLE = null;', () => 'const SITE_BUNDLE = ' + JSON.stringify(bundle) + ';')
  .replace("|| 'dev';", () => `|| '${buildId}';`);
if (!idx.includes(`|| '${buildId}';`)) throw new Error('BUILD_ID の埋め込み位置が見つかりません');
if (idx === idxSrc) throw new Error('SITE_BUNDLE の埋め込み位置が見つかりません');

// コードは tar.gz → base64 にして埋め込む (installスクリプトは約64KBが上限のため)。
// tar は自前で書く: 外部の tar コマンド(OSで挙動が違う)に依存しない
const CODE_FILES = ['index.js', 'external-api.js', 'speech-text.js'];
function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644', 100);                                       // mode
  h.write('0000000', 108);                                       // uid
  h.write('0000000', 116);                                       // gid
  h.write(data.length.toString(8).padStart(11, '0'), 124);      // size
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136); // mtime
  h.write('        ', 148);                                      // checksum (計算前は空白)
  h.write('0', 156);                                             // 通常のファイル
  h.write('ustar', 257); h.write('00', 263);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(sum.toString(8).padStart(6, '0'), 148); h[154] = 0; h[155] = 0x20;
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tarball = Buffer.concat([
  ...CODE_FILES.map((f) => tarEntry(f, f === 'index.js' ? Buffer.from(idx) : fs.readFileSync(f))),
  Buffer.alloc(1024),
]);
const codeB64 = zlib.gzipSync(tarball, { level: 9 }).toString('base64').replace(/(.{76})/g, '$1\n');

const script = `#!/bin/bash
apt-get update && apt-get install -y python3 make g++ git curl
mkdir -p /mnt/server && cd /mnt/server
cat > package.json <<'PKGEOF'
${pkg}PKGEOF
# コード(${CODE_FILES.join(', ')})は再インストールで上書きする (設定は環境変数・settings.json なので安全)
base64 -d <<'CODEEOF' | tar xz -C /mnt/server
${codeB64}
CODEEOF
npm install --omit=dev
echo "install complete"
`;

// Pterodactyl は install スクリプトを TEXT 列(約64KB)に保存するため、超えると末尾が欠けて壊れる
const bytes = Buffer.byteLength(script);
console.log(`install スクリプト: ${bytes} bytes (上限 65535)`);
if (bytes > 60000) throw new Error('install スクリプトが大きすぎます。埋め込みを減らしてください');

const v = (name, description, env_variable, default_value, rules) => ({
  name, description, env_variable, default_value,
  user_viewable: true, user_editable: true, rules, field_type: 'text',
});
const egg = {
  _comment: 'DO NOT EDIT: FILE GENERATED AUTOMATICALLY BY PTERODACTYL PANEL - PTERODACTYL.IO',
  meta: { version: 'PTDL_v2', update_url: null },
  exported_at: new Date().toISOString(),
  name: 'VOICEVOX Discord Bot',
  author: 'keinosuke575@gmail.com',
  description: 'VOICEVOX公開API(open.voicevox.nogame-no.life)を使ったDiscord読み上げBOT',
  features: null,
  docker_images: { 'Node.js 20': 'ghcr.io/parkervcp/yolks:nodejs_20' },
  file_denylist: [],
  startup: 'node index.js',
  config: { files: '{}', startup: '{"done": "ログイン:"}', logs: '{}', stop: '^C' },
  scripts: { installation: { script, container: 'node:20-bookworm-slim', entrypoint: 'bash' } },
  variables: [
    v('Discord Token', 'Discord BOTのトークン。複数VCに同時参加させる場合はカンマ区切りで複数指定 (トークン1つ=同時に1VC)', 'DISCORD_TOKEN', '', 'required|string'),
    v('VOICEVOX API Key', 'vvx_ から始まるAPIキー', 'VOICEVOX_API_KEY', '', 'required|string'),
    v('Primary Bot', 'コマンドを受け付けるBOT。DISCORD_TOKENの並び順(1始まり)かBOTのユーザーID。空欄で1番目', 'PRIMARY_BOT', '', 'nullable|string'),
    v('Default Speaker', 'デフォルト話者ID (3=ずんだもん)', 'DEFAULT_SPEAKER', '3', 'required|integer'),
    v('Max Chars', '1メッセージの最大読み上げ文字数', 'MAX_CHARS', '100', 'required|integer|between:10,2000'),
    v('Ping Webhook URL', 'Pingグラフを定期送信するWebhook URL (空欄で無効)', 'PING_WEBHOOK_URL', '', 'nullable|string'),
    v('Ping Report Minutes', 'Pingレポートの送信間隔(分)', 'PING_REPORT_MIN', '30', 'required|integer|between:1,1440'),
    v('Ping Sample Seconds', 'Ping計測間隔(秒)', 'PING_SAMPLE_SEC', '30', 'required|integer|between:5,600'),
    v('Site Port', '内蔵サイト/外部連携APIの待受ポート(127.0.0.1)。0で無効化', 'SITE_PORT', '8080', 'required|integer|between:0,65535'),
    v('Cloudflare Tunnel Token', 'Cloudflare Tunnelのトークン(固定ドメインで公開)。空欄で無効', 'CF_TUNNEL_TOKEN', '', 'nullable|string'),
    v('Cloudflare Quick Tunnel', 'true: トークンなしで一時URL(trycloudflare.com)を発行。URLはコンソールに表示', 'CF_QUICK_TUNNEL', 'false', 'required|string|in:true,false'),
    v('API Base URL', 'VOICEVOX APIのベースURL', 'VOICEVOX_BASE_URL', 'https://open.voicevox.nogame-no.life', 'required|string'),
  ],
};
fs.writeFileSync('egg-voicevox-discord-bot.json', JSON.stringify(egg, null, 4));
console.log('egg-voicevox-discord-bot.json を生成しました');
