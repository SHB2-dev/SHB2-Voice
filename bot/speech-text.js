'use strict';
// 読み上げ用の文章の整形 (通常の発言も、外部API経由の依頼も、同じ処理を通す)

function createTextTools({ settings, maxChars }) {
  // サーバー辞書: 単語 → 読み。長い単語を先に置き換える (英字は大文字小文字を区別しない)
  function applyDict(text, guildId) {
    const dict = settings.guilds[guildId]?.dict;
    if (!dict) return text;
    const words = Object.keys(dict).sort((a, b) => b.length - a.length);
    if (!words.length) return text;
    const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    return text.replace(re, (m) => dict[m] ?? dict[words.find((w) => w.toLowerCase() === m.toLowerCase())] ?? m);
  }

  function cleanText(raw, guildId) {
    let t = raw
      .replace(/https?:\/\/\S+/g, 'ユーアールエル')
      .replace(/<a?:(\w+):\d+>/g, '$1')
      // メンション(ping)表記: @表示名 / #チャンネル名 になっている前提。記号を落として「〜さん」と読む
      .replace(/@everyone/g, '全員宛て')
      .replace(/@here/g, 'オンライン宛て')
      .replace(/(^|\s)@(\S+)/g, '$1$2さん')
      .replace(/(^|\s)#(\S+)/g, '$1$2チャンネル')
      .replace(/```[\s\S]*?```/g, 'コードブロック')
      .replace(/\|\|[\s\S]*?\|\|/g, 'ネタバレ')
      .trim();
    t = applyDict(t, guildId);
    if (t.length > maxChars) t = t.slice(0, maxChars) + '、以下略';
    return t;
  }

  return { applyDict, cleanText };
}

/**
 * 外部から来た依頼1件を「読む文章・声・速度」にする。
 *  - user_id があれば、その人の声・速度・読み上げ名(/name)を使う。無ければ既定の声・速度
 *  - say_name が true なら、先に「{読み上げ名}さん。」と読む
 *  - item.voice_id / item.speed があれば、それで上書きする
 * @param {{cleanText: Function, applyDict: Function, userCfg: Function, defaultSpeaker: number,
 *          getGuild: (guildId: string) => object|undefined}} d  getGuild は discord.js の Guild (または同じ形のもの)
 */
function createPrepareItem({ cleanText, applyDict, userCfg, defaultSpeaker, getGuild }) {
  return async function prepareItem(guildId, item) {
    const guild = getGuild(guildId);
    let raw = item.text;
    if (guild) {
      // 外部の文章には、メンションが <@id> のまま入っているので、表示名に直す
      raw = raw
        .replace(/<@!?(\d+)>/g, (_, id) => `@${guild.members.cache.get(id)?.displayName ?? 'ユーザー'}`)
        .replace(/<@&(\d+)>/g, (_, id) => `@${guild.roles.cache.get(id)?.name ?? 'ロール'}`)
        .replace(/<#(\d+)>/g, (_, id) => `#${guild.channels.cache.get(id)?.name ?? 'チャンネル'}`);
    }
    let text = cleanText(raw, guildId);
    const cfg = item.user_id ? userCfg(item.user_id) : { speaker: defaultSpeaker, speed: 1.0 };
    if (item.say_name && item.user_id) {
      const member = guild
        ? (guild.members.cache.get(item.user_id) ?? await guild.members.fetch(item.user_id).catch(() => null))
        : null;
      const name = (cfg.name || member?.displayName || '').slice(0, 20);
      if (name) text = applyDict(`${name}さん。`, guildId) + text;
    }
    return { text, speaker: item.voice_id ?? cfg.speaker, speed: item.speed ?? cfg.speed };
  };
}

module.exports = { createTextTools, createPrepareItem };
