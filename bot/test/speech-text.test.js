'use strict';
// 読み上げ文の整形と、外部依頼1件の準備 (声・速度・読み上げ名) のテスト: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTextTools, createPrepareItem } = require('../speech-text');

const GID = '111111111111111111';
const U1 = '222222222222222222'; // 設定あり
const U2 = '333333333333333333'; // 設定なし (表示名だけ)
const U3 = '444444444444444444'; // サーバーにいない

function setup({ dict, maxChars = 100 } = {}) {
  const settings = {
    users: {
      [U1]: { speaker: 8, speed: 1.3, name: 'ずんだ' },
      [U2]: { speaker: 3, speed: 1.0 },
    },
    guilds: { [GID]: dict ? { dict } : {} },
  };
  const tools = createTextTools({ settings, maxChars });
  const userCfg = (id) => settings.users[id] || { speaker: 3, speed: 1.0 };
  const members = new Map([[U1, { displayName: 'ひろし' }], [U2, { displayName: 'たろう' }]]);
  let fetched = 0;
  const guild = {
    members: {
      cache: members,
      fetch: async (id) => { fetched++; if (id === U3) throw new Error('Unknown Member'); return { displayName: 'フェッチ' }; },
    },
    roles: { cache: new Map([['555555555555555555', { name: '管理者' }]]) },
    channels: { cache: new Map([['666666666666666666', { name: '雑談' }]]) },
  };
  const prepare = createPrepareItem({ ...tools, userCfg, defaultSpeaker: 3, getGuild: (g) => (g === GID ? guild : undefined) });
  return { ...tools, prepare, guild, fetchedCount: () => fetched };
}

test('整形: URL・絵文字・コードブロック・ネタバレ・メンション', () => {
  const { cleanText } = setup();
  assert.equal(cleanText('見て https://example.com/a?b=1 これ', GID), '見て ユーアールエル これ');
  assert.equal(cleanText('<:smile:123> と <a:dance:456>', GID), 'smile と dance');
  assert.equal(cleanText('前 ```const a = 1;``` 後', GID), '前 コードブロック 後');
  assert.equal(cleanText('||犯人は犬||', GID), 'ネタバレ');
  assert.equal(cleanText('@ひろし こんにちは', GID), 'ひろしさん こんにちは');
  assert.equal(cleanText('#雑談 に移動', GID), '雑談チャンネル に移動');
  assert.equal(cleanText('@everyone と @here', GID), '全員宛て と オンライン宛て');
  assert.equal(cleanText('mail a@b.com', GID), 'mail a@b.com', 'メールアドレスの@は変換しない');
});

test('整形: 長文は maxChars で切って「、以下略」', () => {
  const { cleanText } = setup({ maxChars: 10 });
  assert.equal(cleanText('あ'.repeat(10), GID), 'あ'.repeat(10));
  assert.equal(cleanText('あ'.repeat(11), GID), 'あ'.repeat(10) + '、以下略');
});

test('サーバー辞書: 長い単語が優先・英字は大文字小文字を区別しない・他サーバーには効かない', () => {
  const { applyDict, cleanText } = setup({ dict: { SHB2: 'エスエイチビーツー', SHB: 'シュビ' } });
  assert.equal(applyDict('shb2 と SHB', GID), 'エスエイチビーツー と シュビ');
  assert.equal(applyDict('SHB2', '999'), 'SHB2');
  assert.equal(cleanText('SHB2です', GID), 'エスエイチビーツーです', '整形の中で辞書が使われる');
});

test('外部の依頼: user_id があれば、その人の声・速度で読む', async () => {
  const { prepare } = setup();
  assert.deepEqual(await prepare(GID, { text: 'ニャーン会議', user_id: U1 }), { text: 'ニャーン会議', speaker: 8, speed: 1.3 });
});

test('外部の依頼: user_id が無ければ、既定の声(3)・速度(1.0)', async () => {
  const { prepare } = setup();
  assert.deepEqual(await prepare(GID, { text: 'お題' }), { text: 'お題', speaker: 3, speed: 1.0 });
});

test('外部の依頼: say_name は、読み上げ名(/name)を優先し、未設定なら表示名。先に「〜さん。」と読む', async () => {
  const { prepare } = setup();
  assert.equal((await prepare(GID, { text: '回答', user_id: U1, say_name: true })).text, 'ずんださん。回答');
  assert.equal((await prepare(GID, { text: '回答', user_id: U2, say_name: true })).text, 'たろうさん。回答');
});

test('外部の依頼: say_name でも、user_id が無い・名前が分からないなら、名前は読まない', async () => {
  const { prepare } = setup();
  assert.equal((await prepare(GID, { text: '回答', say_name: true })).text, '回答');
  assert.equal((await prepare(GID, { text: '回答', user_id: U3, say_name: true })).text, '回答');
});

test('外部の依頼: キャッシュに無いメンバーは、取得して表示名を使う', async () => {
  const s = setup();
  const r = await s.prepare(GID, { text: '回答', user_id: '777777777777777777', say_name: true });
  assert.equal(r.text, 'フェッチさん。回答');
  assert.equal(s.fetchedCount(), 1);
});

test('外部の依頼: say_name が false/未指定なら、名前は読まない(キャッシュにいても取得もしない)', async () => {
  const s = setup();
  assert.equal((await s.prepare(GID, { text: '回答', user_id: U1 })).text, '回答');
  assert.equal((await s.prepare(GID, { text: '回答', user_id: U1, say_name: false })).text, '回答');
  assert.equal(s.fetchedCount(), 0);
});

test('外部の依頼: voice_id / speed は、本人の設定より優先して上書きする', async () => {
  const { prepare } = setup();
  assert.deepEqual(await prepare(GID, { text: 'a', user_id: U1, voice_id: 1, speed: 0.8 }), { text: 'a', speaker: 1, speed: 0.8 });
  assert.deepEqual(await prepare(GID, { text: 'a', voice_id: 2 }), { text: 'a', speaker: 2, speed: 1.0 });
  assert.deepEqual(await prepare(GID, { text: 'a', user_id: U1, speed: 2.0 }), { text: 'a', speaker: 8, speed: 2.0 });
});

test('外部の依頼: 整形(URL・辞書・長文)は通常の読み上げと同じ。メンションの <@id> は表示名に直す', async () => {
  const { prepare } = setup({ dict: { Lumi: 'ルミ' }, maxChars: 30 });
  assert.equal((await prepare(GID, { text: 'Lumi です https://example.com' })).text, 'ルミ です ユーアールエル');
  assert.equal((await prepare(GID, { text: '<@' + U2 + '> 宛て' })).text, 'たろうさん 宛て');
  assert.equal((await prepare(GID, { text: '<@&555555555555555555> と <#666666666666666666>' })).text, '管理者さん と 雑談チャンネル');
  assert.equal((await prepare(GID, { text: 'あ'.repeat(31) })).text, 'あ'.repeat(30) + '、以下略');
});

test('外部の依頼: 読み上げ名にも辞書が効く', async () => {
  const { prepare } = setup({ dict: { ずんだ: 'ズンダ' } });
  assert.equal((await prepare(GID, { text: '回答', user_id: U1, say_name: true })).text, 'ズンダさん。回答');
});

test('外部の依頼: BOTがそのサーバーにいなくても(guild が無くても)、整形と声の決定はできる', async () => {
  const { prepare } = setup();
  assert.deepEqual(await prepare('999', { text: '<@1> x', user_id: U1, say_name: true }), { text: 'ずんださん。<@1> x', speaker: 8, speed: 1.3 });
});
