const fs = require('fs');
const { Readable } = require('stream');
const {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, MessageFlags,
  ChannelType, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection, generateDependencyReport,
} = require('@discordjs/voice');

console.log(generateDependencyReport());
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

// DISCORD_TOKEN はカンマ区切りで複数指定可能。トークン1つ = BOT1体 = 1サーバーで1つのVCを担当する。
const TOKENS = (process.env.DISCORD_TOKEN || '').split(',').map((t) => t.trim()).filter(Boolean);
const API_KEY = process.env.VOICEVOX_API_KEY;
const BASE = (process.env.VOICEVOX_BASE_URL || 'https://open.voicevox.nogame-no.life').replace(/\/$/, '');
const DEFAULT_SPEAKER = Number(process.env.DEFAULT_SPEAKER || 3);
const MAX_CHARS = Number(process.env.MAX_CHARS || 100);
// 設定の保存先。Railway など再デプロイで消える環境では、永続ボリュームのパスを DATA_DIR に指定する (例 /data)
const DATA_FILE = require('path').join(process.env.DATA_DIR || '.', 'settings.json');
if (process.env.DATA_DIR) fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

if (!TOKENS.length || !API_KEY) {
  console.error('DISCORD_TOKEN と VOICEVOX_API_KEY を設定してください。');
  process.exit(1);
}

// ---- 設定保存 (ユーザーごとの話者 / 話速) ----
let settings = { users: {}, guilds: {} };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(settings, null, 2));
const userCfg = (id) => settings.users[id] || { speaker: DEFAULT_SPEAKER, speed: 1.0 };

// ---- VOICEVOX API ----
let styles = []; // { label, id }
async function loadSpeakers() {
  const res = await fetch(`${BASE}/speakers`);
  if (!res.ok) throw new Error(`/speakers ${res.status}`);
  const data = await res.json();
  styles = data.flatMap((s) => s.styles.map((st) => ({ label: `${s.name}（${st.name}）`, id: st.id })));
  console.log(`話者スタイル ${styles.length} 件を取得`);
}

async function synthesize(text, speaker, speed) {
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', input: text, voice: String(speaker), response_format: 'wav', speed }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS ${res.status}: ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// 読み上げ用の整形・サーバー辞書は speech-text.js (通常の発言も、外部APIの依頼も、同じ処理)
const DICT_MAX = 200;
const { createTextTools, createPrepareItem } = require('./speech-text');
const { applyDict, cleanText } = createTextTools({ settings, maxChars: MAX_CHARS });
const clean = (msg) => cleanText(msg.cleanContent, msg.guild?.id);

// ---- コマンド定義 ----
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('VCに参加し、このチャンネルとVCのチャットを読み上げます')
    .addChannelOption((o) => o.setName('vc').setDescription('参加するVC/ステージ (省略時は自分のいるVC)')
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
    .addStringOption((o) => o.setName('bot').setDescription('参加させるBOT (省略時は空いているBOT)').setAutocomplete(true)),
  new SlashCommandBuilder().setName('channel').setDescription('読み上げ対象のテキストチャンネルを管理します')
    .addSubcommand((s) => s.setName('add').setDescription('チャンネルを読み上げ対象に追加')
      .addChannelOption((o) => o.setName('target').setDescription('省略時はこのチャンネル')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildAnnouncement, ChannelType.PublicThread)))
    .addSubcommand((s) => s.setName('remove').setDescription('チャンネルを読み上げ対象から外す')
      .addChannelOption((o) => o.setName('target').setDescription('省略時はこのチャンネル')))
    .addSubcommand((s) => s.setName('list').setDescription('読み上げ対象の一覧')),
  new SlashCommandBuilder().setName('dict').setDescription('サーバー辞書 (単語の読み方を登録)')
    .addSubcommand((s) => s.setName('add').setDescription('単語と読みを登録 (同じ単語は上書き)')
      .addStringOption((o) => o.setName('word').setDescription('単語 (例: SHB2)').setMaxLength(30).setRequired(true))
      .addStringOption((o) => o.setName('reading').setDescription('読み (例: エスエイチビーツー)').setMaxLength(60).setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('登録した単語を削除')
      .addStringOption((o) => o.setName('word').setDescription('削除する単語').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('登録済みの一覧')),
  new SlashCommandBuilder().setName('autojoin').setDescription('VC自動接続のオン/オフ (誰かがVCに入ると空いている号機が自動参加)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('mode').setDescription('オン/オフ').setRequired(true)
      .addChoices({ name: 'オン', value: 'on' }, { name: 'オフ', value: 'off' })),
  new SlashCommandBuilder().setName('announce').setDescription('入退出アナウンス (「○○が参加しました」) のオン/オフ')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('mode').setDescription('省略すると、今の状態を表示')
      .addChoices({ name: 'オン', value: 'on' }, { name: 'オフ', value: 'off' })),
  new SlashCommandBuilder().setName('external').setDescription('外部連携 (Lumi などから読み上げを依頼するAPI) の設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('action').setDescription('省略すると、オン/オフの状態を表示')
      .addChoices({ name: 'オン (トークンを発行)', value: 'on' }, { name: '再生成 (古いトークンを無効化)', value: 'regenerate' }, { name: 'オフ (トークンを無効化)', value: 'off' })),
  new SlashCommandBuilder().setName('status').setDescription('各号機の使用状況を表示します'),
  new SlashCommandBuilder().setName('ping').setDescription('Discord/VOICEVOX APIの応答速度を直近のグラフ付きで表示します'),
  new SlashCommandBuilder().setName('leave').setDescription('VCから退出します'),
  new SlashCommandBuilder().setName('skip').setDescription('再生中の読み上げをスキップします'),
  new SlashCommandBuilder().setName('voice').setDescription('自分の読み上げ声を設定します (省略すると、操作画面を開きます)')
    .addIntegerOption((o) => o.setName('speaker').setDescription('話者 (省略すると、操作画面)').setAutocomplete(true)),
  new SlashCommandBuilder().setName('help').setDescription('コマンドの一覧を表示します'),
  new SlashCommandBuilder().setName('license').setDescription('ライセンスとクレジットを表示します'),
  new SlashCommandBuilder().setName('name').setDescription('入退出・発言時に呼ばれる自分の読み上げ名を設定します (省略でリセット)')
    .addStringOption((o) => o.setName('value').setDescription('読み方 (例: ずんだもん)').setMaxLength(20)),
  new SlashCommandBuilder().setName('speed').setDescription('自分の読み上げ速度を設定します')
    .addNumberOption((o) => o.setName('value').setDescription('0.5〜2.0').setMinValue(0.5).setMaxValue(2.0).setRequired(true)),
].map((c) => c.toJSON());

// 読み上げ対象チャンネルID -> 担当BOTのユーザーID (BOT間の二重読み上げ防止)
const owners = new Map();

// 1つの /join で空いているBOTが自動で入る。コマンドは先頭のトークン(primary)だけが登録・受信し、
// 2体目以降(worker)はコマンドを持たず、primary からの指示でVCに入退出する。
// 全BOTを同じサーバーに招待しておくこと。
const bots = [];

// ---- 外部連携API (/api/v1) と /external ----
const { createExternalApi } = require('./external-api');
const APP_VERSION = '1.2.0';
const BUILD_ID = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'dev'; // build-egg.js がビルド日時を埋め込む (どの版が動いているか確認するため)
console.log(`SHB2 読み上げBOT v${APP_VERSION} build ${BUILD_ID}`);
const guildOf = (guildId) => bots.map((b) => b.client.guilds.cache.get(guildId)).find(Boolean);

const prepareExternalItem = createPrepareItem({ cleanText, applyDict, userCfg, defaultSpeaker: DEFAULT_SPEAKER, getGuild: guildOf });

const externalApi = createExternalApi({
  settings, save, bots, synthesize, prepareItem: prepareExternalItem,
  guildName: (gid) => guildOf(gid)?.name ?? null,
  version: APP_VERSION,
  log: (m) => console.log(m),
  // Railway など、プロキシの後ろで動くときは、X-Forwarded-For の末尾を接続元として扱う
  options: { trustProxy: process.env.TRUST_PROXY === 'true' || !!process.env.RAILWAY_ENVIRONMENT },
});

function startBot(token, isPrimary) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  const guilds = new Map(); // guildId -> { channelIds, player, queue, playing }
  // @discordjs/voice の接続はプロセス内で共有されるため、BOTごとに group を分ける
  const group = () => client.user.id;
  const vconn = (guildId) => getVoiceConnection(guildId, group());

  // 再起動後に自動で戻れるよう、いる場所(VCと読み上げ対象)を保存する。退出・切断・キックで消す
  // (プロセスの停止では release は呼ばれないので、保存したまま残る)
  function persist(g) {
    if (!g?.vcId) return;
    ((settings.sessions ||= {})[client.user.id] ||= {})[g.guildId] = { vcId: g.vcId, channelIds: [...g.channelIds] };
    save();
  }
  function release(guildId) {
    const g = guilds.get(guildId);
    if (g) for (const c of g.channelIds) if (owners.get(c) === client.user.id) owners.delete(c);
    guilds.delete(guildId);
    if (settings.sessions?.[client.user.id]?.[guildId]) { delete settings.sessions[client.user.id][guildId]; save(); }
  }
  function playNext(guildId) {
    const g = guilds.get(guildId);
    if (!g) return;
    const wav = g.queue.shift();
    if (!wav) { g.playing = false; return; }
    g.playing = true;
    g.player.play(createAudioResource(Readable.from([wav])));
  }
  function enqueue(guildId, wav) {
    const g = guilds.get(guildId);
    if (!g) return;
    g.queue.push(wav);
    if (!g.playing) playNext(guildId);
  }
  // 他のBOTが担当していないチャンネルだけ追加。拒否されたIDを返す
  function addChannels(g, ids) {
    const rejected = [];
    for (const id of ids) {
      const o = owners.get(id);
      if (o && o !== client.user.id) rejected.push(id);
      else { g.channelIds.add(id); owners.set(id, client.user.id); }
    }
    persist(g);
    return rejected;
  }
  const bot = { id: tokenId(token), client, guilds, group, vconn, release, playNext, enqueue, addChannels, persist };
  bots.push(bot);

  client.once('clientReady', async () => {
    console.log(`ログイン: ${client.user.tag}${isPrimary ? ' (primary)' : ' (worker)'}`);
    // primary だけがコマンドを持つ。worker は過去に登録したコマンドを消す
    await new REST().setToken(token).put(Routes.applicationCommands(client.user.id), { body: isPrimary ? commands : [] });
    if (isPrimary && !styles.length) { try { await loadSpeakers(); } catch (e) { console.error(e); } }
    await restoreSessions(bot);
  });

  if (isPrimary) {
    client.on('interactionCreate', (i) => handleInteraction(i, bot).catch((e) => {
      // 10062: 応答の期限(3秒)切れ / 40060: すでに別のプロセスが応答済み。BOTの不具合ではないので、1行だけ残す
      if (e?.code === 10062 || e?.code === 40060) console.warn(`[interaction] /${i.commandName ?? '?'} に応答できませんでした (${e.code}): ${e.code === 10062 ? '期限切れ。同じトークンのBOTが、別の場所でも動いていないか確認してください' : '別のプロセスが先に応答済み'}`);
      else console.error(e);
    }));
    client.on('voiceStateUpdate', (o, n) => handleAutoJoin(o, n).catch((e) => console.error(e)));
  }

  client.on('messageCreate', async (m) => {
    if (m.author.bot || !m.guild) return;
    const g = guilds.get(m.guild.id);
    if (!g || !g.channelIds.has(m.channelId)) return;
    const text = clean(m);
    if (!text) return;
    const cfg = userCfg(m.author.id);
    try {
      enqueue(m.guild.id, await synthesize(text, cfg.speaker, cfg.speed));
    } catch (e) { console.error(e.message); }
  });

  // 入退出アナウンス + 全員抜けたら自動退出
  client.on('voiceStateUpdate', async (oldS, newS) => {
    const guildId = newS.guild.id;
    const conn = vconn(guildId);
    const g = guilds.get(guildId);
    if (!conn || !g) return;
    const vcId = conn.joinConfig.channelId;
    const ch = newS.guild.channels.cache.get(vcId);
    const humans = ch ? ch.members.filter((x) => !x.user.bot).size : 0;

    if (humans === 0) { conn.destroy(); release(guildId); return; }

    const member = newS.member ?? oldS.member;
    if (!member || member.id === client.user.id) return;
    const joined = newS.channelId === vcId && oldS.channelId !== vcId;
    const left = oldS.channelId === vcId && newS.channelId !== vcId;
    if (!joined && !left) return;
    if (settings.guilds[guildId]?.announce === false) return; // /announce でオフにしたサーバー

    const cfg = userCfg(member.id);
    const name = (cfg.name || member.displayName).slice(0, 20);
    try {
      enqueue(guildId, await synthesize(applyDict(`${name}が${joined ? '参加' : '退出'}しました`, guildId), cfg.speaker, cfg.speed));
    } catch (e) { console.error(e.message); }
  });

  client.login(token).catch((e) => console.error('ログイン失敗:', e.message));
  return client;
}

// 号機ごとの状況: ○=空き / ✕=使用中(VC名) / －=このサーバーに未招待
const zen = (n) => String(n).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
function statusText(guild) {
  return bots.map((b, idx) => {
    const label = `${zen(idx + 1)}号機`;
    if (!b.client.isReady() || !b.client.guilds.cache.has(guild.id)) return `${label} －`;
    if (!b.guilds.has(guild.id)) return `${label} ○`;
    const vcId = b.vconn(guild.id)?.joinConfig.channelId;
    return `${label} ✕ (${guild.channels.cache.get(vcId)?.name ?? '使用中'})`;
  }).join('\n');
}

// このサーバーに未インストールのBOTの名前と招待URL (空なら空文字)
const INVITE_PERMS = 4302310400; // チャンネルを表示/メッセージを送る/接続/発言/メンバーをミュート/スピーカー参加をリクエスト
// URLは生で出さず、BOT名にリンクを埋め込む (embedのfieldで表示)
function missingText(guild) {
  return bots.map((b, idx) => ({ b, idx }))
    .filter(({ b }) => !b.client.guilds.cache.has(guild.id))
    .map(({ b, idx }) => {
      const name = b.client.user?.username ?? `${zen(idx + 1)}号機`;
      return `[${name}](https://discord.com/oauth2/authorize?client_id=${b.id}&scope=bot+applications.commands&permissions=${INVITE_PERMS})`;
    }).join('\n');
}

// /join /status の返信用embed: 説明 + 号機の状況 + 未インストールのBOT(招待リンク付きの名前)
function infoEmbed(guild, title, description) {
  const fields = [{ name: '号機の状況', value: statusText(guild) }];
  const missing = missingText(guild);
  if (missing) fields.push({ name: '📥 未インストールのBOT（名前をクリックして招待）', value: missing });
  return { title, description, color: 0xf1c40f, fields, timestamp: new Date().toISOString() };
}

const list = (g) => [...g.channelIds].map((c) => `<#${c}>`).join(' ');

// 入退出を担当できるBOT (primary も含む)
const inGuild = (b, i) => b.client.isReady() && b.client.guilds.cache.has(i.guild.id);

// 操作対象のBOT: ユーザーのいるVCを担当しているBOT → 実行チャンネルを担当しているBOT の順で探す
function findBot(i) {
  const vcId = i.member?.voice?.channelId;
  const byVc = bots.find((b) => b.guilds.has(i.guild.id) && b.vconn(i.guild.id)?.joinConfig.channelId === vcId);
  if (byVc) return byVc;
  const ownerId = owners.get(i.channelId);
  return bots.find((b) => b.client.user?.id === ownerId && b.guilds.has(i.guild.id));
}

// bot をVCに接続し、読み上げ対象(textChannelIds + VC自身のチャット)を登録する。ステージなら発言権も取る
async function connectBot(bot, guildId, vcId, textChannelIds) {
  const { client } = bot;
  const guild = client.guilds.cache.get(guildId);
  const vc = guild.channels.cache.get(vcId);
  const me = guild.members.me;
  // 接続前に権限を確認して、足りなければ原因を分かりやすく伝える (名前が非表示のVC = BOTから見えない可能性)
  if (!vc) throw new Error(`${client.user.username} には、このVCが見えていません。VCの権限で、BOTのロールに「チャンネルを表示」と「接続」を許可してください。`);
  const need = [[PermissionFlagsBits.ViewChannel, 'チャンネルを表示'], [PermissionFlagsBits.Connect, '接続'], [PermissionFlagsBits.Speak, '発言']];
  const lacking = need.filter(([p]) => !vc.permissionsFor(me).has(p)).map(([, n]) => n);
  if (lacking.length) throw new Error(`${client.user.username} に、**${vc.name}** の権限「${lacking.join('」「')}」がありません。VCの権限設定で、BOTのロールに許可してください。`);
  if (vc.full && !vc.permissionsFor(me).has(PermissionFlagsBits.MoveMembers)) throw new Error(`**${vc.name}** は人数上限に達しているため、入れません。`);
  const connection = joinVoiceChannel({
    channelId: vcId, guildId, adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true, group: bot.group(),
  });
  const player = createAudioPlayer();
  connection.subscribe(player);
  const state = { channelIds: new Set(), player, queue: [], playing: false, guildId, vcId };
  bot.guilds.set(guildId, state);
  bot.addChannels(state, [...textChannelIds, vcId]);
  player.on(AudioPlayerStatus.Idle, () => bot.playNext(guildId));
  player.on('error', (e) => { console.error(e); bot.playNext(guildId); });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch { connection.destroy(); }
  });
  connection.on('stateChange', (o, n) => console.log(`[voice:${client.user.username}] ${o.status} -> ${n.status}`));
  connection.on(VoiceConnectionStatus.Destroyed, () => bot.release(guildId));

  // ステージチャンネル: 発言権を取る (ミュート権限があれば即スピーカー、なければ挙手)
  let note = '';
  if (vc.type === ChannelType.GuildStageVoice) {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15000);
      const me = guild.members.me;
      if (vc.permissionsFor(me).has(PermissionFlagsBits.MuteMembers)) {
        await me.voice.setSuppressed(false);
        note = '\nステージのスピーカーになりました。';
      } else {
        await me.voice.setRequestToSpeak(true);
        note = '\nステージで挙手しました。モデレーターがスピーカーに招待すると読み上げが始まります。';
      }
    } catch (e) {
      console.error(e);
      note = '\nステージでの発言権の取得に失敗しました。BOTに「メンバーをミュート」または「スピーキングのリクエスト」権限が必要です。';
    }
  }
  return { state, note };
}

// 再起動したとき、保存しておいた場所(VC・読み上げ対象)に、自動で戻る
async function restoreSessions(bot) {
  const saved = settings.sessions?.[bot.client.user.id];
  if (!saved) return;
  for (const [guildId, s] of Object.entries({ ...saved })) {
    try {
      if (!bot.client.guilds.cache.has(guildId)) throw new Error('サーバーにいません');
      await connectBot(bot, guildId, s.vcId, (s.channelIds || []).filter((c) => c !== s.vcId));
      console.log(`[restore] ${bot.client.user.username} -> ${bot.client.guilds.cache.get(guildId)?.channels.cache.get(s.vcId)?.name ?? s.vcId} に再接続`);
    } catch (e) {
      // 戻れない場所(VCの削除・権限の変更・サーバーから退出)は、保存を消す
      console.warn(`[restore] ${bot.client.user.username}: 再接続できませんでした (${guildId}): ${e.message}`);
      bot.release(guildId);
    }
  }
}

// VC自動接続: 人がVCに入ったとき、空いている号機を自動で参加させる (/autojoin on のサーバーのみ)
async function handleAutoJoin(oldS, newS) {
  const guild = newS.guild;
  if (!settings.guilds[guild.id]?.autoJoin) return;
  if (!newS.member || newS.member.user.bot) return;
  if (!newS.channelId || newS.channelId === oldS.channelId) return;
  if (newS.channelId === guild.afkChannelId) return;
  if (owners.has(newS.channelId)) return; // すでに担当の号機がいる
  const bot = bots.find((b) => b.client.isReady() && b.client.guilds.cache.has(guild.id) && !b.guilds.has(guild.id));
  if (!bot) return;
  try {
    const { note } = await connectBot(bot, guild.id, newS.channelId, []);
    const vc = guild.channels.cache.get(newS.channelId);
    // VCのチャットに案内 (権限がなければ黙って無視)
    await bot.client.channels.cache.get(newS.channelId)?.send(
      `**${bot.client.user.username}** が自動参加しました。このチャットの発言を読み上げます。${note}\n声の変更は \`/voice\`、退出は \`/leave\` です。`).catch(() => {});
    console.log(`[autojoin] ${bot.client.user.username} -> ${vc?.name}`);
  } catch (e) { console.error('自動接続失敗:', e.message); }
}

// ---- 音声設定の操作画面 (/voice) ----
// 本人にだけ見える(ephemeral)ので、他の人は操作できない。状態は customId に持たせる (vp:<操作>:<ページ>)
const PANEL_PAGE = 25;
function voicePanel(userId, page) {
  const cfg = userCfg(userId);
  const idx = styles.findIndex((s) => s.id === cfg.speaker);
  const pages = Math.max(1, Math.ceil(styles.length / PANEL_PAGE));
  if (page == null) page = idx >= 0 ? Math.floor(idx / PANEL_PAGE) : 0;
  page = Math.min(Math.max(page, 0), pages - 1);
  const cur = idx >= 0 ? styles[idx].label : `ID ${cfg.speaker}`;
  const embed = {
    color: 0x7c4dff,
    title: '🎤 音声設定',
    description: 'あなたの音声設定です。全号機の読み上げに、適用されます。\n\n'
      + `**現在の話者:** ${cur}\n**速度:** ${cfg.speed}`,
    footer: { text: '設定は、選んだ時点で保存されます' },
  };
  const rows = [];
  if (styles.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`vp:sel:${page}`).setPlaceholder('話者を選択')
      .addOptions(styles.slice(page * PANEL_PAGE, (page + 1) * PANEL_PAGE).map((s) => ({
        label: s.label.slice(0, 100), value: String(s.id), default: s.id === cfg.speaker,
      })))));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vp:go:${page - 1}`).setLabel('前').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId('vp:page').setLabel(`${page + 1} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`vp:go:${page + 1}`).setLabel('次').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    ));
  } else {
    embed.description += '\n\n話者の一覧を、まだ取得できていません。少し待ってから、もう一度開いてください。';
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vp:speed:${page}`).setLabel(`速度を変更 (現在: ${cfg.speed})`).setEmoji('🔊').setStyle(ButtonStyle.Primary)));
  return { embeds: [embed], components: rows };
}

async function handlePanel(i) {
  const [, op, arg] = i.customId.split(':');
  const page = Number(arg) || 0;
  if (i.isStringSelectMenu() && op === 'sel') {
    const id = Number(i.values[0]);
    if (!styles.some((s) => s.id === id)) return i.update(voicePanel(i.user.id, page));
    settings.users[i.user.id] = { ...userCfg(i.user.id), speaker: id };
    save();
    return i.update(voicePanel(i.user.id, page));
  }
  if (i.isButton() && op === 'go') return i.update(voicePanel(i.user.id, page));
  if (i.isButton() && op === 'speed') {
    return i.showModal(new ModalBuilder().setCustomId(`vp:speedmodal:${page}`).setTitle('速度を変更')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('value').setLabel('速度 (0.5〜2.0)').setStyle(TextInputStyle.Short)
        .setValue(String(userCfg(i.user.id).speed)).setMinLength(1).setMaxLength(5).setRequired(true))));
  }
  if (i.isModalSubmit() && op === 'speedmodal') {
    const v = Number(i.fields.getTextInputValue('value').trim().replace(/[０-９．]/g, (c) => c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
    if (!Number.isFinite(v) || v < 0.5 || v > 2.0) {
      return i.reply({ content: '速度は、0.5〜2.0 の数字で入力してください。', flags: MessageFlags.Ephemeral });
    }
    settings.users[i.user.id] = { ...userCfg(i.user.id), speed: Math.round(v * 100) / 100 };
    save();
    return i.update(voicePanel(i.user.id, page));
  }
}

function helpEmbed() {
  return {
    color: 0x7c4dff,
    title: 'SHB2－読み上げBOT コマンド一覧',
    description: '詳しい使い方: https://shb2-bot.shishen575.com/',
    fields: [
      { name: '読み上げ', value: '`/join` 空いている号機がVCに参加 (`vc:` `bot:` で指定も可)\n`/leave` 退出\n`/skip` 再生中の読み上げをスキップ\n`/channel add|remove|list` 読み上げ対象のチャンネル' },
      { name: '自分の設定', value: '`/voice` 声・速度の操作画面 (`speaker:` で直接指定も可)\n`/speed` 速度 (0.5〜2.0)\n`/name` 読み上げ名 (省略でリセット)' },
      { name: 'サーバーの設定', value: '`/dict add|remove|list` サーバー辞書\n`/autojoin` VC自動接続 (管理権限)\n`/announce` 入退出アナウンス\n`/external` 外部連携API (管理権限)' },
      { name: '情報', value: '`/status` 号機の状況\n`/ping` 応答速度のグラフ\n`/help` このメッセージ\n`/license` ライセンス・クレジット' },
    ],
  };
}

function licenseEmbed() {
  return {
    color: 0x7c4dff,
    title: 'ライセンス・クレジット',
    description: `**SHB2－読み上げBOT** v${APP_VERSION}\nソースコード: MIT License (Copyright (c) 2026 SHB2-dev)\nhttps://github.com/SHB2-dev/SHB2-Voice`,
    fields: [
      { name: '音声', value: '音声合成は [VOICEVOX](https://voicevox.hiroshiba.jp/) を使っています (公開API: https://open.voicevox.nogame-no.life/docs)。\n各キャラクター・音声ライブラリの利用規約と、クレジット表記に従ってください。' },
      { name: '注意', value: 'MIT License は、このBOTのソースコードだけが対象です。VOICEVOX・キャラクターの規約は、別です。VOICEVOX公式、およびAPIの運営者とは、関係ありません。' },
    ],
  };
}

async function handleInteraction(i, primary) {
  if (i.isAutocomplete()) {
    if (i.options.getFocused(true).name === 'word') {
      const q = i.options.getFocused().toLowerCase();
      return i.respond(Object.keys(settings.guilds[i.guild.id]?.dict ?? {})
        .filter((w) => w.toLowerCase().includes(q)).slice(0, 25).map((w) => ({ name: w.slice(0, 100), value: w })));
    }
    if (i.options.getFocused(true).name === 'bot') {
      const q = i.options.getFocused().toLowerCase();
      return i.respond(bots
        .filter((b) => inGuild(b, i) && !b.guilds.has(i.guild.id))
        .filter((b) => b.client.user.username.toLowerCase().includes(q))
        .slice(0, 25).map((b) => ({ name: b.client.user.username.slice(0, 100), value: b.client.user.id })));
    }
    const q = i.options.getFocused().toLowerCase();
    return i.respond(styles.filter((s) => s.label.toLowerCase().includes(q) || String(s.id) === q)
      .slice(0, 25).map((s) => ({ name: `${s.label} [${s.id}]`.slice(0, 100), value: s.id })));
  }
  if (i.customId?.startsWith('vp:')) return handlePanel(i);
  if (!i.isChatInputCommand() || !i.guild) return;
  const reply =(content) => i.reply({ content, flags: MessageFlags.Ephemeral });

  switch (i.commandName) {
    case 'status': {
      const embed = infoEmbed(i.guild, '号機の状況', '○ 空き　✕ 使用中　－ 未招待');
      embed.footer = { text: `v${APP_VERSION} / build ${BUILD_ID}` };
      embed.fields.push({ name: '入退出アナウンス', value: settings.guilds[i.guild.id]?.announce === false ? '⚪ オフ' : '🟢 オン' });
      embed.fields.push({ name: '外部連携', value: externalApi.isEnabled(i.guild.id) ? '🟢 オン' : '⚪ オフ' });
      return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    case 'announce': {
      const mode = i.options.getString('mode');
      const gs = (settings.guilds[i.guild.id] ||= {});
      if (mode) { gs.announce = mode === 'on'; save(); }
      const on = gs.announce !== false; // 既定はオン
      return reply(mode
        ? `入退出アナウンスを **${on ? 'オン' : 'オフ'}** にしました。`
        : `入退出アナウンスは **${on ? 'オン' : 'オフ'}** です。`);
    }
    case 'external': {
      // トークンは、生成した直後の1回だけ、実行した本人にだけ見える形で表示する
      const action = i.options.getString('action');
      const gid = i.guild.id;
      const tokenMsg = (head, token) => `${head}\n\`\`\`\n${token}\n\`\`\`\nLumi のダッシュボードの「読み上げ連携」に貼り付けてください。このトークンは**今回しか表示されません**。`;
      if (action === 'on') {
        const r = externalApi.enable(gid);
        return reply(r.already ? '外部連携は、すでに **オン** です。（トークンは再表示できません。必要なら「再生成」を使ってください）' : tokenMsg('外部連携を **オン** にしました。トークン:', r.token));
      }
      if (action === 'regenerate') {
        return reply(tokenMsg('新しいトークンを発行しました。古いトークンは、すぐに無効になりました。', externalApi.regenerate(gid).token));
      }
      if (action === 'off') {
        externalApi.disable(gid);
        return reply('外部連携を **オフ** にしました。トークンは無効です。');
      }
      return reply(`外部連携は **${externalApi.isEnabled(gid) ? 'オン' : 'オフ'}** です。`);
    }
    case 'ping': {
      await i.deferReply();
      try {
        await sample(); // 最新の1点を追加してから描画
        const { embed } = await buildPingReport(MAX_POINTS, primary.client.ws.ping);
        embed.fields.push({ name: 'コマンド往復', value: `${Date.now() - i.createdTimestamp}ms` });
        return i.editReply({ embeds: [embed] });
      } catch (e) {
        console.error(e);
        return i.editReply(`グラフの生成に失敗しました: ${e.message}`);
      }
    }
    case 'join': {
      const vc = i.options.getChannel('vc') ?? i.member.voice.channel;
      if (!vc) return reply('VCを指定するか、先にボイスチャンネルに参加してください。');
      const wanted = i.options.getString('bot');

      // すでにこのVCを担当しているBOTがいれば、読み上げ対象チャンネルを追加するだけ
      const ownerId = owners.get(vc.id);
      const existing = bots.find((b) => b.client.user.id === ownerId);
      if (existing) {
        const g = existing.guilds.get(i.guild.id);
        if (!g) return reply('このVCは別のサーバーで使用中です。');
        const rej = existing.addChannels(g, [i.channelId, vc.id]);
        return i.reply(`読み上げ対象: ${list(g)}${rej.length ? '\n（他のBOTが担当中のため追加できないチャンネルがあります）' : ''}`);
      }

      // 空いているBOT = このサーバーにいて、まだVCに入っていないBOT
      const bot = bots.find((b) => inGuild(b, i) && !b.guilds.has(i.guild.id)
        && (!wanted || b.client.user.id === wanted));
      if (!bot && wanted) return reply('指定したBOTは使用中か、このサーバーにいません。');
      if (!bot) {
        const count = bots.filter((b) => inGuild(b, i)).length;
        return count
          ? i.reply({ embeds: [infoEmbed(i.guild, '空いているBOTがいません', `このサーバーのBOT ${count}体がすべて使用中です。`)], flags: MessageFlags.Ephemeral })
          : reply('このサーバーにBOTがいません。');
      }
      await i.deferReply();
      let state, note;
      try {
        ({ state, note } = await connectBot(bot, i.guild.id, vc.id, [i.channelId]));
      } catch (e) {
        console.error('join失敗:', e.message);
        return i.editReply(`⚠️ 参加できませんでした。\n${e.message}`);
      }
      return i.editReply({
        embeds: [infoEmbed(i.guild, `${bot.client.user.username} が参加しました`,
          `**${vc.name}** に参加しました。\n読み上げ対象: ${list(state)}${note}`)],
      });
    }
    case 'dict': {
      const gs = (settings.guilds[i.guild.id] ||= {});
      const dict = (gs.dict ||= {});
      const sub = i.options.getSubcommand();
      if (sub === 'add') {
        const word = i.options.getString('word').trim();
        const reading = i.options.getString('reading').trim();
        if (!word || !reading) return reply('単語と読みを入力してください。');
        if (!(word in dict) && Object.keys(dict).length >= DICT_MAX) return reply(`辞書がいっぱいです（最大${DICT_MAX}件）。不要な単語を /dict remove で削除してください。`);
        dict[word] = reading;
        save();
        return i.reply(`📖 辞書に登録しました: **${word}** → ${reading}`);
      }
      if (sub === 'remove') {
        const word = i.options.getString('word');
        if (!(word in dict)) return reply(`「${word}」は登録されていません。`);
        delete dict[word];
        save();
        return i.reply(`🗑️ 辞書から削除しました: **${word}**`);
      }
      const entries = Object.entries(dict);
      if (!entries.length) return reply('辞書は空です。/dict add で登録できます。');
      const lines = entries.map(([w, r]) => `${w} → ${r}`);
      let text = `📖 サーバー辞書（${entries.length}件）\n`;
      for (const l of lines) { if ((text + l).length > 1900) { text += '…（以下省略）'; break; } text += l + '\n'; }
      return reply(text);
    }
    case 'autojoin': {
      const on = i.options.getString('mode') === 'on';
      settings.guilds[i.guild.id] = { ...(settings.guilds[i.guild.id] || {}), autoJoin: on };
      save();
      return reply(on
        ? 'VC自動接続を **オン** にしました。誰かがVCに入ると、空いている号機が自動で参加して、そのVCのチャットを読み上げます。'
        : 'VC自動接続を **オフ** にしました。');
    }
    case 'channel': {
      const bot = findBot(i);
      if (!bot) return reply('先にBOTのいるVCに入って /join してください。');
      const g = bot.guilds.get(i.guild.id);
      const sub = i.options.getSubcommand();
      const target = i.options.getChannel('target')?.id ?? i.channelId;
      let warn = '';
      if (sub === 'add' && bot.addChannels(g, [target]).length) warn = '\n他のBOTが担当中のチャンネルは追加できません。';
      if (sub === 'remove') {
        if (g.channelIds.size <= 1 && g.channelIds.has(target)) return reply('最後の1チャンネルは外せません。/leave を使ってください。');
        g.channelIds.delete(target);
        if (owners.get(target) === bot.client.user.id) owners.delete(target);
        bot.persist(g);
      }
      return reply(`**${bot.client.user.username}** の読み上げ対象: ${list(g)}${warn}`);
    }
    case 'leave': {
      const bot = findBot(i);
      if (!bot) return reply('退出させるBOTが見つかりません。BOTのいるVCに入ってから実行してください。');
      bot.vconn(i.guild.id)?.destroy();
      bot.release(i.guild.id);
      return reply(`**${bot.client.user.username}** が退出しました。`);
    }
    case 'skip': {
      findBot(i)?.guilds.get(i.guild.id)?.player.stop();
      return reply('スキップしました。');
    }
    case 'help': return i.reply({ embeds: [helpEmbed()], flags: MessageFlags.Ephemeral });
    case 'license': return i.reply({ embeds: [licenseEmbed()], flags: MessageFlags.Ephemeral });
    case 'voice': {
      const id = i.options.getInteger('speaker');
      if (id == null) return i.reply({ ...voicePanel(i.user.id), flags: MessageFlags.Ephemeral });
      settings.users[i.user.id] = { ...userCfg(i.user.id), speaker: id };
      save();
      const name = styles.find((s) => s.id === id)?.label ?? `ID ${id}`;
      return reply(`声を **${name}** に設定しました。`);
    }
    case 'name': {
      const v = i.options.getString('value')?.trim();
      settings.users[i.user.id] = { ...userCfg(i.user.id), name: v || undefined };
      save();
      return reply(v ? `読み上げ名を **${v}** に設定しました。` : '読み上げ名をリセットしました（表示名で読みます）。');
    }
    case 'speed': {
      const v = i.options.getNumber('value');
      settings.users[i.user.id] = { ...userCfg(i.user.id), speed: v };
      save();
      return reply(`速度を **${v}** に設定しました。`);
    }
  }
}

// PRIMARY_BOT: コマンドを受け付けるBOT。トークンの並び順(1始まり)かBOTのユーザーIDで指定。省略時は1番目。
const tokenId = (t) => { try { return Buffer.from(t.split('.')[0], 'base64').toString(); } catch { return ''; } };
function pickPrimary() {
  const want = (process.env.PRIMARY_BOT || '').trim();
  if (!want) return 0;
  if (/^\d{1,3}$/.test(want) && Number(want) >= 1 && Number(want) <= TOKENS.length) return Number(want) - 1;
  const byId = TOKENS.findIndex((t) => tokenId(t) === want);
  if (byId >= 0) return byId;
  console.error(`PRIMARY_BOT="${want}" に一致するBOTがありません。1番目を使います。`);
  return 0;
}
const primaryIdx = pickPrimary();
const clients = TOKENS.map((t, idx) => startBot(t, idx === primaryIdx));

// ---- Ping 計測 / グラフ ----
// PING_SAMPLE_SEC 秒ごとに Discord REST と VOICEVOX API の応答時間を記録し、直近 MAX_POINTS 点だけ保持する。
// /ping と Webhook の定期レポートで、この履歴をグラフ化する。グラフ画像は quickchart.io で生成する
// (外部に送られるのは時刻とms値のみ)。
const WEBHOOK = process.env.PING_WEBHOOK_URL;
const REPORT_MIN = Number(process.env.PING_REPORT_MIN || 30);
const SAMPLE_SEC = Number(process.env.PING_SAMPLE_SEC || 30);
const MAX_POINTS = 360;
const history = []; // { t: Date, discord: number|null, voicevox: number|null }

const hhmmss = (d) => d.toLocaleTimeString('ja-JP', { hour12: false, timeZone: 'Asia/Tokyo' });
async function timeIt(url) {
  const t0 = Date.now();
  try { const r = await fetch(url); return r.ok ? Date.now() - t0 : null; } catch { return null; }
}
async function sample() {
  const [discord, voicevox] = await Promise.all([
    timeIt('https://discord.com/api/v10/gateway'),
    timeIt(`${BASE}/version`),
  ]);
  history.push({ t: new Date(), discord, voicevox });
  if (history.length > MAX_POINTS) history.shift();
}
function stats(arr) {
  const v = arr.filter((x) => x !== null);
  if (!v.length) return '計測失敗';
  return `平均 ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}ms / 最小 ${Math.min(...v)}ms / 最大 ${Math.max(...v)}ms`;
}

// 直近 count 点のグラフ付きembedと画像を作る
async function buildPingReport(count, wsPing) {
  const data = history.slice(-count);
  if (!data.length) throw new Error('計測データがありません');
  const dMs = data.map((s) => s.discord);
  const vMs = data.map((s) => s.voicevox);
  const spanMin = Math.max(1, Math.round(((data.at(-1).t - data[0].t) / 60000)));
  // 画像はアップロードせず、QuickChart の短縮URL(/chart/create)をembedの image.url に入れて表示する
  const chart = await fetch('https://quickchart.io/chart/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      width: 600, height: 250, format: 'png', backgroundColor: 'white',
      chart: {
        type: 'line',
        data: {
          labels: data.map((s) => hhmmss(s.t)),
          datasets: [
            { label: 'Discord REST (ms)', data: dMs, fill: true, tension: 0.4, pointRadius: 0, spanGaps: true,
              borderColor: 'rgb(99,102,241)', backgroundColor: 'rgba(99,102,241,0.15)' },
            { label: 'VOICEVOX API (ms)', data: vMs, fill: true, tension: 0.4, pointRadius: 0, spanGaps: true,
              borderColor: 'rgb(34,197,94)', backgroundColor: 'rgba(34,197,94,0.15)' },
          ],
        },
        options: { scales: { y: { beginAtZero: true, title: { display: true, text: 'ms' } },
          x: { ticks: { maxRotation: 60, maxTicksLimit: 10 } } } },
      },
    }),
  });
  if (!chart.ok) throw new Error(`quickchart ${chart.status}`);
  const created = await chart.json();
  if (!created.success || !created.url) throw new Error('quickchart: グラフのURLを取得できませんでした');
  const embed = {
    title: `Ping (直近${spanMin}分 / ${data.length}点)`,
    color: 0xf1c40f,
    fields: [
      { name: 'Discord REST', value: stats(dMs) },
      { name: 'VOICEVOX API', value: stats(vMs) },
      { name: 'WebSocket', value: `${Math.round(wsPing)}ms` },
    ],
    image: { url: created.url },
    timestamp: new Date().toISOString(),
  };
  return { embed };
}

sample();
setInterval(sample, SAMPLE_SEC * 1000);

if (WEBHOOK) {
  setInterval(async () => {
    try {
      const { embed } = await buildPingReport(Math.ceil((REPORT_MIN * 60) / SAMPLE_SEC), clients[primaryIdx].ws.ping);
      const res = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!res.ok) throw new Error(`webhook ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) { console.error('pingレポート送信失敗:', e.message); }
  }, REPORT_MIN * 60 * 1000);
  console.log(`Pingレポート有効: ${SAMPLE_SEC}秒ごとに計測 / ${REPORT_MIN}分ごとに送信`);
}

// ---- サイト公開 (任意) ----
// サイトを 127.0.0.1:SITE_PORT で配信し、Cloudflare Tunnel (cloudflared) で外部に公開する。
// サイトのファイルはこのファイルに埋め込める (build-egg.js が SITE_BUNDLE に ../site を埋め込む)。
// 埋め込みがなければ ./site フォルダを配信する。cloudflared は無ければ起動時に自動でダウンロードする。
//   CF_TUNNEL_TOKEN  : 設定すると固定ドメインのトンネルで公開 (Cloudflare Zero Trust で Public Hostname の
//                      Service を http://localhost:<SITE_PORT> にしておく)
//   CF_QUICK_TUNNEL=true : トークンなしで trycloudflare.com の一時URLを発行 (ログにURLが出る)
//   SITE_PORT=0      : サイト自体を無効化
const SITE_BUNDLE = null; // { "index.html": "<gzip→base64>" }  ※Pterodactylのegg(installスクリプト)は約64KBが上限なので圧縮して埋め込む
// SITE_PORT 未設定で PORT があれば(Railway など)、そのポートで外向けに(0.0.0.0)待ち受ける。
// それ以外は 127.0.0.1 のみ (Cloudflare Tunnel など、同じ端末からの接続だけ)
const SITE_PORT = Number(process.env.SITE_PORT ?? process.env.PORT ?? 8080);
const SITE_HOST = process.env.SITE_HOST || (process.env.SITE_PORT === undefined && process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const hasSite = SITE_BUNDLE || fs.existsSync('./site/index.html');

// 外部連携API (/api/v1) も、このサーバーが受ける (サイトが無くても動く)
if (SITE_PORT > 0) {
  const http = require('http');
  const path = require('path');
  const root = path.resolve('./site');
  const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const bundle = SITE_BUNDLE ? new Map(Object.entries(SITE_BUNDLE).map(([k, v]) => [k, require('zlib').gunzipSync(Buffer.from(v, 'base64'))])) : null;

  http.createServer((req, res) => {
    externalApi.handle(req, res).then((handled) => { if (!handled) serveStatic(req, res); })
      .catch((e) => { console.error('http error:', String(e?.message || e).slice(0, 80)); if (!res.headersSent) res.writeHead(500).end(); });
  }).listen(SITE_PORT, SITE_HOST, () => console.log(`サイト/API待受: http://${SITE_HOST}:${SITE_PORT}${bundle ? ' (サイト埋め込み)' : hasSite ? '' : ' (サイトなし)'}`));

  function serveStatic(req, res) {
    let p;
    try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400).end('bad request'); return; }
    if (p.endsWith('/')) p += 'index.html';
    const rel = path.posix.normalize(p).replace(/^\/+/, '');
    if (rel.startsWith('..')) { res.writeHead(403).end('forbidden'); return; }
    const send = (data) => res.writeHead(200, {
      'Content-Type': types[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300',
    }).end(data);
    const notFound = () => res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    if (bundle) return bundle.has(rel) ? send(bundle.get(rel)) : notFound();
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) return notFound();
    fs.readFile(file, (err, data) => (err ? notFound() : send(data)));
  }

  const token = (process.env.CF_TUNNEL_TOKEN || '').trim();
  const quick = process.env.CF_QUICK_TUNNEL === 'true';
  if (token || quick) startTunnel(token, quick).catch((e) => console.error('Cloudflare Tunnel 起動失敗:', e.message));

  async function ensureCloudflared() {
    const win = process.platform === 'win32';
    const bin = win ? './cloudflared.exe' : './cloudflared';
    if (fs.existsSync(bin)) return bin;
    const os = win ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${arch}${win ? '.exe' : ''}`;
    console.log('cloudflared をダウンロードします...');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cloudflared のダウンロードに失敗 (${res.status})`);
    fs.writeFileSync(bin, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    return bin;
  }

  async function startTunnel(token, quick) {
    const bin = await ensureCloudflared();
    const { spawn } = require('child_process');
    const args = token
      ? ['tunnel', '--no-autoupdate', 'run', '--token', token]
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${SITE_PORT}`];
    const start = () => {
      const cf = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const onLine = (buf) => {
        const s = buf.toString();
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) console.log(`Cloudflare Tunnel 公開URL: ${m[0]}`);
        else if (/Registered tunnel connection|ERR|error/i.test(s)) console.log(`[cloudflared] ${s.trim().split('\n').pop().slice(0, 200)}`);
      };
      cf.stdout.on('data', onLine); cf.stderr.on('data', onLine);
      cf.on('exit', (code) => { console.error(`cloudflared が終了 (code ${code})。10秒後に再起動します`); setTimeout(start, 10000); });
    };
    start();
    console.log(token ? 'Cloudflare Tunnel (固定ドメイン) を起動します' : 'Cloudflare Tunnel (一時URL) を起動します');
  }
}
