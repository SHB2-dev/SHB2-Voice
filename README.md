# SHB2－読み上げBOT

VOICEVOX の声で、Discord のテキストチャットを読み上げる BOT です。最大6体(号機)が、同じサーバーで、それぞれ別のVCを同時に担当できます。

- サイト(使い方・コマンド一覧): https://shb2-bot.shishen575.com/
- 音声合成: [VOICEVOX](https://voicevox.hiroshiba.jp/) (公開API: <https://open.voicevox.nogame-no.life/docs>)
- 外部連携API の仕様書: [docs/openapi.yaml](docs/openapi.yaml)

## 構成

| 場所 | 内容 |
|---|---|
| `bot/index.js` | BOT 本体 (discord.js / @discordjs/voice) |
| `bot/external-api.js` | 外部連携API (`/api/v1`)。トークン管理・認証・回数制限・読み上げ依頼 |
| `bot/speech-text.js` | 読み上げ文の整形、サーバー辞書、外部依頼の声・速度・読み上げ名の決定 |
| `bot/test/` | テスト (`cd bot && npm test`) |
| `bot/build-egg.js` | Pterodactyl 用の egg を生成する (`node build-egg.js`) |
| `site/` | サイト。egg の中に埋め込まれ、BOT が配信する |
| `docs/openapi.yaml` | 外部連携API の仕様書 (OpenAPI 3.0) |
| `redirect/` | 旧URL用のリダイレクトページ |

## 主なコマンド

| コマンド | 内容 |
|---|---|
| `/join` | 空いている号機が、VCに参加して読み上げを開始 (`vc:` `bot:` で指定も可) |
| `/leave` `/skip` | 退出 / 読み上げのスキップ |
| `/channel add\|remove\|list` | 読み上げ対象のチャンネルの管理 |
| `/voice` `/speed` `/name` | 自分の声・速度・読み上げ名 |
| `/dict add\|remove\|list` | サーバー辞書 |
| `/autojoin` | VC自動接続 (サーバー管理権限) |
| **`/external`** | **外部連携API の設定 (サーバー管理権限)** |
| `/status` `/ping` | 号機の状況(外部連携のオン/オフも表示) / 応答速度のグラフ |

コマンドは、1号機 (`PRIMARY_BOT` で変更可) だけが受け付けます。

## 外部連携API (Lumi などから読み上げを依頼する)

ほかの BOT・サービスから、HTTP で読み上げを依頼できます。たとえば Lumi の大喜利では、お題と、回答者本人の声・速度での回答を、読み上げさせます。

- ベースURL: `https://shb2-bot.shishen575.com/api/v1`
- 仕様書: [docs/openapi.yaml](docs/openapi.yaml)

### 使い始める

1. サーバーの管理者が、`/external` で「オン」を選ぶ。そのサーバー専用のトークン (`shb2_...`) が、**1回だけ**表示されます (本人にだけ見えます)。
2. トークンを、依頼する側 (Lumi のダッシュボードの「読み上げ連携」) に貼り付ける。
3. 読み上げてほしいチャンネルで、VC に号機を参加させておく (`/join` か `/autojoin`)。

| `/external` の引数 | 動作 |
|---|---|
| オン | トークンを発行して、1回だけ表示。すでにオンなら「オンです」(再表示しない) |
| 再生成 | 新しいトークンを発行。**古いトークンは、すぐに無効**。(オフの状態で実行すると、オンになります) |
| オフ | 外部連携を止める。トークンを無効にする |
| (なし) | オン/オフの状態を表示 |

### 認証

`Authorization: Bearer <トークン>`。トークンは**サーバーごと**で、そのサーバーの読み上げだけを依頼できます (`guild_id` は不要で、入れても無視します)。

- トークンは、暗号論的に安全な乱数 32 バイト。形式は `shb2_` + base64url。
- 保存するのは、**SHA-256 のハッシュだけ** (`settings.json`)。平文は保存しません。照合は一定時間の比較です。
- 無効・不明・取り消し済みは、理由を区別せず、すべて `401`。

### エンドポイント

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/v1/speak` | 読み上げの依頼 (1〜20件、順番どおり) |
| GET | `/api/v1/session?channel_id=...` | いま読み上げ中か |
| GET | `/api/v1/health` | 接続テスト (サーバー名を返す) |

```bash
curl -X POST https://shb2-bot.shishen575.com/api/v1/speak \
  -H "Authorization: Bearer shb2_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: lumi-ogiri-0001" \
  -d '{
    "channel_id": "お題が出ているテキストチャンネルのID",
    "items": [
      { "text": "お題。猫が会議で言った一言は?" },
      { "text": "ニャーン会議", "user_id": "回答者のユーザーID", "say_name": true }
    ],
    "source": "lumi:ogiri"
  }'
# => {"status":"queued","bot":2,"queued":2}   /   対象の号機がいなければ {"status":"no_session"}
```

- `user_id` があれば、そのユーザーの声・速度 (`/voice` `/speed`) で読みます。`say_name: true` なら、先に「{読み上げ名}さん。」と読みます (読み上げ名は `/name`、未設定なら表示名)。
- `user_id` が無ければ、既定の声・速度。`voice_id` (VOICEVOX のスタイルID)、`speed` (0.5〜2.0) で上書きもできます。
- 整形 (URL・メンション・絵文字・ネタバレ、サーバー辞書、長文の切り詰め) は、通常の読み上げと同じです。「BOTの発言は読み上げない」ルールは、このAPIには適用しません。
- `channel_id` を読み上げ対象にしている号機で読みます。複数あれば、1号機に近い方。
- `Idempotency-Key` が同じ依頼は、10分間は無視します (再送で二重に読みません)。

### 制限

| 項目 | 上限 |
|---|---|
| リクエスト数 | 1トークン (=1サーバー) あたり、1分に60回 (超えると `429` + `Retry-After`) |
| ボディ | 64KB (超えると `413`) |
| items / text | 1〜20件 / 1〜500文字 (超えると `413`、空や形式の誤りは `400`) |
| 認証の失敗 | 1分に10回/IP (超えると、そのIPを1分間 `429`。ブロック中は、正しいトークンも通しません) |

### データの扱い

外部から来た文章は、読み上げのため VOICEVOX 公開API に送信されます。**保存はしません**。ログにも本文は残さず、サーバーIDと件数だけを残します。

### 公開のしかた

API は、サイトと同じ内蔵の Web サーバー (`SITE_PORT`、既定 8080) で受けます。外に出すには、Cloudflare Tunnel (`CF_TUNNEL_TOKEN`) を使い、トンネルの Public Hostname の Service を `http://localhost:8080` にしてください。

## Railway で動かす

リポジトリのルートに、`Dockerfile` と `railway.json` があります。Railway は、これを使ってビルドします。

### 手順

1. このフォルダ(`SHB2`)を、GitHub のリポジトリにする (または `railway up` で、フォルダごとアップロード)。
2. Railway で「New Project」→「Deploy from GitHub repo」で、そのリポジトリを選ぶ。
3. **ボリュームを追加して、`/data` にマウントする** (サービスの「Volumes」)。設定 (`settings.json`) の保存先です。**これが無いと、再デプロイのたびに、各人の声の設定、辞書、外部連携のトークンが消えます。**
4. 「Variables」に、環境変数を入れる (下の表)。
5. 公開するドメインを決める。サービスの「Settings」→「Networking」で、「Generate Domain」(`*.up.railway.app`)、または「Custom Domain」に `shb2-bot.shishen575.com` を追加し、表示された CNAME を DNS (Cloudflare) に登録する。Cloudflare Tunnel は、不要です。

### 環境変数

| 変数 | 内容 |
|---|---|
| `DISCORD_TOKEN` | **必須**。BOTのトークン。複数ならカンマ区切り (1つ目が、コマンドを受け付ける号機) |
| `VOICEVOX_API_KEY` | **必須**。`vvx_` で始まるAPIキー |
| `DATA_DIR` | 設定の保存先。Dockerfile で `/data` に設定済み (ボリュームのマウント先と合わせる) |
| `PRIMARY_BOT` | コマンドを受け付けるBOT (省略で1番目) |
| `DEFAULT_SPEAKER` `MAX_CHARS` | 既定の話者ID / 読み上げの最大文字数 |
| `PING_WEBHOOK_URL` `PING_REPORT_MIN` `PING_SAMPLE_SEC` | Ping レポート (任意) |

`PORT` は、Railway が自動で設定します。サイトと外部連携API (`/api/v1`) は、そのポートで受けます。`SITE_PORT` は、設定しないでください (設定すると、127.0.0.1 だけで待ち受けます)。

- Railway 上では、自動で、X-Forwarded-For の末尾を接続元として扱います (認証失敗のIP制限のため)。Railway 以外のプロキシの後ろで動かすときは、`TRUST_PROXY=true` を設定します。
- 起動ログの先頭に `SHB2 読み上げBOT v1.1.0 build <コミットID>` が出ます。`/status` にも出るので、どの版が動いているか確認できます。
- 音声は、ボイスチャンネルへの UDP 接続を使います。Railway で動かして、VC の接続や音声が不安定な場合は、リージョンを変えて試してください。
- 既存の Pterodactyl 用の egg は、そのまま使えます。

## 開発

```bash
cd bot
npm install
npm test            # 外部連携API・読み上げ文の整形のテスト
node build-egg.js   # egg を生成 (サイトとコードを埋め込む)
```

egg の install スクリプトは、Pterodactyl の制限 (約64KB) があるため、コードを圧縮して埋め込んでいます。`build-egg.js` が、上限を超えるとエラーで止まります。

## 注意

- VOICEVOX と、各音声ライブラリ・キャラクターの利用規約とクレジット表記に従ってください。
- 音声合成は、有志が運営する公開API (VOICEVOX Public API Gateway) を利用しています。VOICEVOX 公式、および API の運営者とは関係ありません。
