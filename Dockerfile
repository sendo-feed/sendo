# コンテナ版のイメージ（docs/decisions/container.md）。上流の CI が作って GHCR に置き、
# 使う人は compose.yaml で動かす。手元で作るときは docker build -t sendo .
#
# 土台のイメージは、ダイジェストで固定する（Dependabot が上げる）。Node のメジャーは .node-version と揃える
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
# pnpm は package.json の packageManager の版を、corepack で入れる
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# バンドルを作る。依存はバンドルに入れず（--packages=external）、動かすときに入れる
FROM base AS build
# インストール時のスクリプト（wrangler types など）は、バンドルには要らないので動かさない
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build:node

# 動かすイメージ。動かすのに要る依存と、バンドルと、マイグレーションだけを入れる
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm store prune \
  && mkdir -p /data \
  && chown node:node /data
COPY migrations ./migrations
COPY --from=build /app/dist/node ./dist/node
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/node/sendo.mjs"]
