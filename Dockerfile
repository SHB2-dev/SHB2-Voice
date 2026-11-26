# Railway など、Docker でデプロイする環境用。リポジトリのルート(このファイルのある場所)でビルドする。
FROM node:20-bookworm-slim

WORKDIR /app

# 依存パッケージ (@discordjs/opus はビルドに失敗しても、opusscript で動く)
COPY bot/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# コードとサイト (index.js は ./site フォルダを配信する)
COPY bot/index.js bot/external-api.js bot/speech-text.js ./
COPY site ./site

# どの版が動いているか分かるよう、コミットIDを受け取る (/version と /status に表示)
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
# 設定(settings.json)の保存先。Railway では、ボリュームを /data にマウントしてください
ENV DATA_DIR=/data

CMD ["node", "index.js"]
