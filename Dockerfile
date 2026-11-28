# Sendo のイメージ（docs/decisions/container.md）。上流の CI が作って GHCR に置き、
# 使う人は compose.yaml で動かす。手元で作るときは docker build -t sendo .
#
# 土台のイメージは、ダイジェストで固定する（Dependabot が上げる）。Node のメジャーは .node-version と揃える
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
# pnpm は package.json の packageManager の版を、corepack で入れる
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 埋め込みのモデルを用意する（docs/decisions/article-analysis.md の 6）。固定した版のファイルを取って SHA-256 を
# 確かめ、行ごとの int8 と倍率のファイルに変換する。合わなければビルドを止める。出来上がりは CPU によらない
# ので、ビルドする機械の CPU のまま動かす。依存のファイルを入れない段（base を土台にしない）にし、固定ファイル
# と道具が変わらなければキャッシュから使われるようにする。土台は base と同じイメージ
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS model
WORKDIR /app
COPY models/potion-multilingual-128m.json ./models/
COPY scripts/prepare-embedding-model.mjs ./scripts/
RUN node scripts/prepare-embedding-model.mjs --out /models/potion-multilingual-128m --cache /tmp/model-cache \
  && rm -rf /tmp/model-cache

# Rust の処理（crates/）を、napi-rs のネイティブのモジュールにする（docs/decisions/tech-stack.md の 5）。
# ビルドするマシンの CPU のまま、イメージの CPU（TARGETARCH）向けにクロスコンパイルする（arm64 を
# エミュレーションでコンパイルすると遅いため）。土台は、動かすイメージと同じ Debian（bookworm）にそろえ、
# glibc の版を合わせる
FROM --platform=$BUILDPLATFORM rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c AS native
ARG TARGETARCH
ARG BUILDARCH
WORKDIR /app
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) target=x86_64-unknown-linux-gnu; packages="gcc-x86-64-linux-gnu libc6-dev-amd64-cross" ;; \
    arm64) target=aarch64-unknown-linux-gnu; packages="gcc-aarch64-linux-gnu libc6-dev-arm64-cross" ;; \
    *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  echo "$target" > /rust-target; \
  if [ "$TARGETARCH" != "$BUILDARCH" ]; then \
    # クロスコンパイル用の gcc と、相手の CPU 向けの C ライブラリ（つなぐときに要る）を入れる
    apt-get update && apt-get install -y --no-install-recommends $packages && rm -rf /var/lib/apt/lists/*; \
  fi
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
RUN set -eu; \
  target="$(cat /rust-target)"; \
  rustup target add "$target"; \
  # 同じ CPU 向けなら、クロスコンパイル用の gcc は入れていないので、ふつうの cc でつなぐ
  if [ "$TARGETARCH" = "$BUILDARCH" ]; then \
    unset CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER; \
  fi; \
  cargo build --release --locked -p sendo-node --target "$target"; \
  cp "target/$target/release/libsendo_node.so" /sendo.node

# バンドルを作る。依存はバンドルに入れず（--packages=external）、動かすときに入れる
FROM base AS build
# インストール時のスクリプトは、バンドルには要らないので動かさない
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# 動かすイメージ。動かすのに要る依存と、バンドルと、マイグレーションと、Rust のモジュールと、埋め込みの
# モデル（モデルカードの README.md にライセンスを書いている）だけを入れる
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
COPY --from=native /sendo.node ./native/sendo.node
COPY --from=model /models/potion-multilingual-128m ./models/potion-multilingual-128m
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/node/sendo.mjs"]
