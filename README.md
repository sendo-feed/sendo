# Sendo

> **鮮度を、導く。** — Fresh feeds, guided.

[![CI](https://github.com/sendo-feed/sendo/actions/workflows/ci.yml/badge.svg)](https://github.com/sendo-feed/sendo/actions/workflows/ci.yml)

Sendo は、オープンソースのフィード集約サーバーです。

- **API・MCP ファースト**：人もエージェントも、同じ入口からフィードを扱える
- **好きなリーダーで読める**：Google Reader API 互換で、Reeder や NetNewsWire がそのまま使える
- **自分で持てる**：セルフホストして、データも設定も手元に置ける

> [!WARNING]
> まだ開発の初期段階で、使える機能はありません。いまは Phase 1（MVP）を作っています。

## 必要なもの

- Node.js 22.12 以上（CI は [.node-version](.node-version) のバージョンで動かす）
- pnpm（バージョンは [package.json](package.json) の `packageManager` で固定している）

pnpm は corepack で入れると、決められたバージョンが自動で使われます。

```sh
corepack enable pnpm
```

Windows では、WSL の中（Linux 側のファイルシステム）にクローンするのがおすすめです。

## はじめかた

```sh
git clone https://github.com/sendo-feed/sendo.git
cd sendo
pnpm install
pnpm db:migrate:local                         # 手元の D1 にテーブルを作る
pnpm token:create --email you@example.com     # ユーザーとアクセストークンを作る
pnpm dev
```

`pnpm token:create` は、ユーザーがいなければ作り、アクセストークン（`sendo_` で始まる文字列）を発行します。トークンは一度だけ表示されるので、控えておいてください。DB にはハッシュだけを置きます。デプロイ先の D1 に作るときは `--remote` を付けます。

`pnpm dev` で、手元に Workers のランタイム（D1、Queues、Cron を含む）が立ち上がります。Cloudflare のアカウントは要りません。

```sh
TOKEN=sendo_...   # pnpm token:create で発行したトークン

# フィードを購読する。サイトの URL でもよい（ページからフィードを見つける）
curl -X POST http://localhost:8787/api/v1/feeds \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"url":"https://blog.cloudflare.com/"}'

# 未読の記事を新しい順に読む（state=starred ならスター付き、folderId ／ feedId で絞り込める）
curl -H "authorization: Bearer $TOKEN" "http://localhost:8787/api/v1/articles?state=unread&limit=10"

# 記事を既読にして、スターを付ける
curl -X PATCH http://localhost:8787/api/v1/articles/<記事の ID> \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"read":true,"starred":true}'

# すべて既読にする。until には、記事の一覧の最初のページの asOf を渡す
# （一覧に出ていなかった記事は未読のまま残る）
curl -X POST http://localhost:8787/api/v1/articles/mark-read \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"all":true,"until":"<一覧の asOf>"}'

# 前回からの差分を取る（ローカルファーストのクライアント向け）。応答の cursor を次に渡す
curl -H "authorization: Bearer $TOKEN" "http://localhost:8787/api/v1/sync"

# Feedly などから書き出した OPML をインポートする（フォルダも取り込む）
curl -X POST http://localhost:8787/api/v1/opml \
  -H "authorization: Bearer $TOKEN" -H "content-type: text/x-opml" \
  --data-binary @subscriptions.opml

# 購読を OPML で書き出す
curl -H "authorization: Bearer $TOKEN" -o sendo.opml http://localhost:8787/api/v1/opml
```

API の定義（OpenAPI）は `http://localhost:8787/api/v1/openapi.json` で読めます。定期的な取得（Cron）は、`pnpm dev --test-scheduled` で起動して `http://localhost:8787/__scheduled` を開くと、すぐに試せます。

## コマンド

| コマンド | すること |
|---|---|
| `pnpm dev` | 手元でサーバーを動かす |
| `pnpm check` | 型チェック、lint、テストをまとめて実行する（PR を出す前に） |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` | lint と整形の確認（Biome） |
| `pnpm format` | 整形して、直せる lint の指摘を直す |
| `pnpm test` | テスト（Workers のランタイムの中で動く） |
| `pnpm build` | デプロイせずにバンドルだけ作って確かめる |
| `pnpm cf-typegen` | `wrangler.jsonc` から型（`worker-configuration.d.ts`）を作り直す |
| `pnpm db:generate` | `src/db/schema.ts` からマイグレーションの SQL を作る |
| `pnpm db:migrate:local` | 手元の D1 にマイグレーションを当てる |
| `pnpm db:migrate` | デプロイ先の D1 にマイグレーションを当てる |
| `pnpm token:create --email <メール>` | ユーザーとアクセストークンを作る（`--remote` でデプロイ先） |

## ディレクトリ構成

```text
sendo/
├── src/
│   ├── index.ts        # Worker の入口（fetch ／ scheduled ／ queue）
│   ├── app.ts          # HTTP のルーティング
│   ├── api/            # REST API（/api/v1）
│   ├── db/             # スキーマとデータの読み書き（Drizzle）。共有のフィード・記事と、人ごとの購読・受信箱
│   ├── fetcher/        # フィードの取得と解析、SSRF 対策
│   ├── jobs/           # キューと定期実行で動く処理
│   ├── opml/           # OPML の読み書き
│   └── platform/       # 実行環境の緩衝層
│       └── cloudflare/ # D1・Queues などの実装
├── migrations/         # D1 のマイグレーション（pnpm db:generate で作る）
├── test/               # テスト（Vitest ＋ Workers のランタイム）
├── docs/
│   ├── decisions/      # 今の決定
│   ├── inception-deck.md
│   ├── tech-deck.md
│   └── features.md
├── wrangler.jsonc      # Cloudflare Workers の設定
└── biome.json          # lint と整形の設定
```

機能を足すときのディレクトリの分け方は、[技術構成](docs/tech-deck.md#6-ディレクトリ構成sendo)にあります。

Cloudflare 固有の機能（`cloudflare:*`）に触れてよいのは `src/index.ts` と `src/platform/cloudflare/` だけで、`src/` では Node.js の組み込みモジュール（`node:*`）を使いません。どちらも lint で検査しています（[決定](docs/decisions/tech-stack.md)）。

## 文書

- [インセプションデッキ](docs/inception-deck.md)：なぜ作るのか、何をやらないか
- [機能一覧](docs/features.md)：何を作るか
- [技術構成](docs/tech-deck.md)：どう作るか
- [決定の一覧](docs/decisions/README.md)：今の決定とその理由

## 貢献

いまは2人で開発していて、外部からの Issue や PR は公開の準備ができてから受け付けます。決まりごとは [CONTRIBUTING.md](https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md) にあります。

## ライセンス

未定です。決まるまでは、すべての権利を留保します。
