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
- Rust（コンテナ版の重い処理と、そのテストに使う。rustup を入れておけば、[rust-toolchain.toml](rust-toolchain.toml) の版が自動で使われる）

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

### 取得の間隔

フィードを取得する間隔（分）は、Cloudflare の画面の変数 `FETCH_INTERVAL_MINUTES` に入れます（[設定を変える](#設定を変える)）。10 以上の整数で、既定は 30 です。取得の時期が来たフィードは 10 分おきの定期実行がキューに積むので、10 分より短くはできません。回せるフィードの数は、Cloudflare のプランとこの間隔で決まります（[決定](docs/decisions/jobs.md)）。

購読するフィードの数に合わせて、次を目安に選んでください。

| 取得の間隔 | 無料プラン | Workers Paid（月 5 ドル） |
|---|---|---|
| 15 分 | 100 フィードまで | 1,000 フィードほど |
| 30 分（既定） | 160 フィードまで | 2,000 フィードほど |
| 1 時間 | 250 フィードまで | 4,000 フィードほど |
| 2 時間 | 340 フィードまで | 8,000 フィードほど |

- 1 人で使い、1 フィードの記事が 1 日平均 5 件のときの数です
- 無料プランは、1 日の上限（先に効くのは D1 の書き込み）の 6 割に収まる数です。D1 の上限を超えると、日本時間 9:00 まで記事を読むこともできなくなるので、余裕を残しています
- Workers Paid は、月 5 ドルに含まれる量に収まる数です。超えても、追加はわずかです
- 記事を残す期間（次の節）が既定の 90 日のときの数です。データベースの容量は、期間の分で頭打ちになります。無料プランの上限は 500MB で、表のどの行も収まります。Workers Paid は 10GB までで、2 時間おき・8,000 フィードだと 9GB ほどになり、上限に近くなります

計算のしかたと前提は、[コストの見積もり](docs/cost.md)にあります。

### 古い記事の片付け

スターを付けていない記事は、取り込んでから 90 日たつと消えます。未読でも消えます。スターを付けた記事は、期間を過ぎても残ります（[決定](docs/decisions/retention.md)）。

期間（日）は、Cloudflare の画面の変数 `ARTICLE_RETENTION_DAYS` に入れます（[設定を変える](#設定を変える)）。30 以上の整数で、既定は 90 です。長くすると、そのぶんデータベースの容量を多く使います。

- 記事を消す処理は、取得のたびと、1 日 1 回（日本時間 3:00）に動きます。一度に消す量は抑えているので、期間を短くすると、何日かかけて消えます
- sendo-reader などのクライアントは、同期で「消えた」と受け取り、手元からも消します。30 日より長く同期しなかったクライアントは、最初から同期し直します

```sh
TOKEN=sendo_...   # pnpm token:create で発行したトークン

# フィードを購読する。サイトの URL でもよい（ページからフィードを見つける）
curl -X POST http://localhost:8787/api/v1/feeds \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"url":"https://blog.cloudflare.com/"}'

# 未読の記事を新しい順に読む（state=starred ならスター付き、folderId ／ feedId で絞り込める）
curl -H "authorization: Bearer $TOKEN" "http://localhost:8787/api/v1/articles?state=unread&limit=10"

# 記事の本文を読む。source=page で、記事のページから抜いた本文（コンテナ版だけ。使えるかは GET /api/v1/features）
curl -H "authorization: Bearer $TOKEN" "http://localhost:8787/api/v1/articles/<記事の ID>/content?source=page"

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

API の定義（OpenAPI）は `http://localhost:8787/api/v1/openapi.json` で読めます。

### ブラウザでログインする（Google）

ブラウザ（sendo-reader）からは、Google でログインしてセッションのクッキーで使います。手元では、試すときだけ設定すれば足ります（なければ `pnpm dev` が警告を出すだけ）。デプロイには 3 つとも要ります（`wrangler.jsonc` の `secrets.required`。ないとデプロイが止まる。[初めてのデプロイ](#初めてのデプロイ)）。

1. [Google Cloud のコンソール](https://console.cloud.google.com/apis/credentials)で OAuth クライアント（種類は「ウェブ アプリケーション」）を作る。「承認済みのリダイレクト URI」には、ブラウザから見た `<オリジン>/api/v1/auth/google/callback` を登録する（手元の sendo-reader なら `http://localhost:5173/api/v1/auth/google/callback`、本番なら sendo-reader のオリジン）
2. `.dev.vars.example` を `.dev.vars` に写し、`ALLOWED_EMAILS`（ユーザーになれるメール）、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` を書く。本番では、Cloudflare の画面にシークレットとして入れる（[初めてのデプロイ](#初めてのデプロイ)）
3. ブラウザで `<オリジン>/api/v1/auth/google/login` を開く。ログインできたら `/` に戻る（`?returnTo=/パス` で戻る先を変えられる）。できなければ `/?login_error=<理由>` に戻る

許可したメールの人が初めてログインすると、ユーザーを作ります。同じメールのユーザー（`pnpm token:create` で作った人など）がいれば、そのユーザーに結び付けます。

ログインしたら、アクセストークン（リーダーアプリのアプリ用パスワード）を `/api/v1/tokens` で発行・一覧・取り消しできます。これはブラウザのセッションでだけ使え、アクセストークンでは使えません（漏れたトークンで新しいトークンを発行させないため）。定期的な取得（Cron）は、`pnpm dev --test-scheduled` で起動して `http://localhost:8787/__scheduled` を開くと、すぐに試せます。

### リーダーアプリで読む（Google Reader API）

Reeder、NetNewsWire など、Google Reader API（FreshRSS 互換）に対応したリーダーアプリから読めます。アカウントの種類は「FreshRSS」か「Google Reader API」を選び、次のように入れます。

| 項目 | 値 |
|---|---|
| サーバー（URL） | Sendo の URL（手元なら `http://localhost:8787`） |
| ユーザー名 | ユーザーのメールアドレス |
| パスワード | アクセストークン（`sendo_` で始まるもの）。ブラウザでログインして `/api/v1/tokens` で発行するか、`pnpm token:create` で発行する。アプリごとに発行すると、あとで個別に取り消せる |

既読・スター・購読・フォルダの変更は、REST API や sendo-reader と同じデータに反映されます。

### AI エージェントからつなぐ（MCP）

`/mcp` にリモート MCP サーバーがあります（[決定](docs/decisions/mcp.md)）。ツールは `list_feeds`、`get_unread`、`get_article`（読む）と、`subscribe`、`unsubscribe`、`mark_read`、`star`（変える）です。

つなぎ方は 2 通りです。どちらのトークンも `/mcp` でしか使えず、リーダーアプリ用のトークンは `/mcp` では使えません。

- **MCP 用のアクセストークン**（Claude Code など、ヘッダーにトークンを書けるクライアント）
- **OAuth**（Claude.ai や ChatGPT のコネクタ）：つなぐときに、sendo-reader の画面で許可します

#### MCP 用のアクセストークンでつなぐ

```sh
# MCP 用のトークンを発行する。--write を付けると、状態を変えるツールも使える（付けなければ読むだけ）
pnpm token:create --email you@example.com --name "Claude Code" --mcp --write
# ブラウザでログインしているなら、POST /api/v1/tokens に {"name":"Claude Code","purpose":"mcp","scopes":["read","write"]} でもよい

# Claude Code に足す
claude mcp add --transport http sendo http://localhost:8787/mcp --header "Authorization: Bearer <トークン>"
```

#### OAuth でつなぐ

Sendo が OAuth の認可サーバーになり、許可の画面は sendo-reader に置きます（[決定](docs/decisions/mcp.md)の 3〜7）。使うには、Cloudflare の画面の変数に 2 つのオリジンを入れます（[設定を変える](#設定を変える)。2 つともなければ OAuth は使えません）。手元では `pnpm dev --var PUBLIC_URL:http://localhost:8787 --var READER_URL:http://localhost:5173` のように入れます。

| 名前 | 入れるもの |
|---|---|
| `PUBLIC_URL` | Sendo を外から呼ぶときのオリジン（例：`https://sendo.example.workers.dev`）。OAuth の発行者になり、クライアントはこのオリジンの `/mcp` につなぐ |
| `READER_URL` | sendo-reader のオリジン。許可の画面（`/oauth/authorize`）がここにある |

クライアントには `<PUBLIC_URL>/mcp` を渡します。クライアントは、`/mcp` の 401 からメタデータ（`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`）をたどり、Client ID Metadata Document か動的登録（`/oauth/register`）でクライアントを示して、許可の画面へ移ります。許可するとトークン（アクセストークンは 1 時間、リフレッシュトークンは 30 日。使うたびに作り直す）を受け取ります。最初は読むだけ（`read`）で、状態を変えるツールを呼ぶと、`write` を足す許可を求め直します。

出した許可は `GET /api/v1/oauth/grants` で一覧にし、`DELETE /api/v1/oauth/grants/{id}` で取り消せます（ブラウザのセッションでだけ）。

動的登録（`/oauth/register`）は、ログインせずに誰でも呼べます。Sendo は、一度も許可されていない登録を 1 日で消し、数も 100 件までにします（超えたら 429 で断る。[決定](docs/decisions/mcp.md)の 5）。連打されても、データベースの容量や書き込みを使い切ることはありません。その間は、動的登録のクライアントが新しくつなげなくなりますが、Client ID Metadata Document のクライアントと MCP 用のトークンは使えます。

守り方は、どこで動かすかで 2 通りです。

- **`workers.dev` で動かす**：上の上限だけで守ります。Cloudflare のレート制限のルール（WAF）は、自分のゾーン（ドメイン）を通るリクエストにしか効かず、`workers.dev` には効きません
- **独自のドメインで動かす**：上限に加えて、Cloudflare のレート制限のルールで `/oauth/register` を絞ってください。無料プランでも 1 つ作れます（パスで絞り、IP ごとに 10 秒で数える）
  1. Cloudflare の画面で、そのドメインの「セキュリティ」→「セキュリティ ルール」→「レート制限のルール」を作る
  2. 条件は「URI のパス」が `/oauth/register` と等しい。同じ IP から 10 秒に 5 回を超えたら、10 秒ブロックする
  3. `PUBLIC_URL` は独自のドメインのオリジンにする。`workers.dev` の URL も開いたままなので、そちらは上の上限で守られます

## デプロイ

Sendo には 2 つの版があり、同じコードから作っています（[決定](docs/decisions/container.md)）。

- **Cloudflare 版**：自分の Cloudflare アカウントの無料プランで動きます。サーバーは要りません。載せるのは、無料プランで動く範囲の機能です（この節）
- **コンテナ版**：自分のサーバー（手元の PC、自宅のサーバー、VPS など）で、Docker で動かします。CPU を多く使う機能も含めて、すべての機能を載せます。fork は要りません（[コンテナ版で動かす](#コンテナ版で動かす)）

Cloudflare 版は、自分の Cloudflare アカウントに、GitHub の fork からデプロイします。fork の `main` に push するたびに、Cloudflare（Workers Builds）がビルドしてデプロイします（[決定](docs/decisions/deploy.md)）。Cloudflare の無料プランで動きます。

### 初めてのデプロイ

1. GitHub で `sendo-feed/sendo` を、自分のアカウントに fork する
2. Cloudflare の画面で、Workers & Pages →「作成」→「リポジトリをインポート」を選び、GitHub につなぐ。Cloudflare の GitHub App を入れるときは、「Repository access」に fork を入れる
   - 入れ忘れると、画面から始めたビルドは動くのに、push してもビルドが始まらない。あとからは、GitHub の Settings → Applications → Cloudflare Workers and Pages で直せる
3. fork を選び、次のように入れてデプロイする

   | 項目 | 値 |
   |---|---|
   | Worker の名前 | `sendo`（変えない。`wrangler.jsonc` の `name` と違うとビルドが失敗し、sendo-reader もこの名前で呼ぶ） |
   | ビルドのコマンド | 空のまま（`pnpm run build` が入っていてもよい） |
   | デプロイのコマンド | `pnpm run deploy`（`run` を付ける。`pnpm deploy` は pnpm 自身のコマンド） |

   - 記事の本文を R2 に置くので、先に Cloudflare の画面の「R2」で、R2 を使えるようにしておく。バケット（`sendo-content`）は、D1 や Queues と同じくデプロイのときに作られる。作られずにデプロイが止まったら、`pnpm exec wrangler r2 bucket create sendo-content` で作ってから、やり直す
4. 1 回目のビルドは、秘密がなくて止まる。D1 と Queues はもうできている。Worker の「設定」→「変数とシークレット」に、型を「**シークレット**」にして、次の 3 つを入れる（型を「変数」にすると、必須の確認を通らず、デプロイでも消える）
   - `ALLOWED_EMAILS`：ユーザーになれるメール（カンマか空白で区切る）
   - `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`：Google の OAuth クライアント（[ブラウザでログインする](#ブラウザでログインするgoogle)）。リダイレクト URI に入れる sendo-reader のオリジンは、`https://<sendo-reader の Worker の名前>.<自分のサブドメイン>.workers.dev` になる。まだなければ、仮の値を入れておき、あとで入れ直してよい
5. Worker の「デプロイ」タブで、止まったビルドをやり直す。マイグレーションを当ててから、デプロイする
6. 手元から、ユーザーとアクセストークンを作り、動くかを確かめる

   ```sh
   pnpm exec wrangler login                                 # 最初に 1 回
   pnpm token:create --email you@example.com --remote
   curl -H "Authorization: Bearer <トークン>" https://sendo.<自分のサブドメイン>.workers.dev/api/v1/feeds
   # → {"items":[]}
   ```

デプロイの手順（`pnpm run deploy`）は、D1 がなければ先にデプロイして D1 と Queues を作らせ、マイグレーションを当ててから、もう一度デプロイします。D1 があれば、マイグレーションを当ててからデプロイします。

手元から初めてデプロイするとき（Workers Builds を使わないとき）は、Worker がまだないので、画面にも `wrangler secret put` にも秘密を入れられません。秘密をファイル（1 行に `名前=値`）に書き、`pnpm run deploy --secrets-file <ファイル>` で渡します。ファイルは、リポジトリの外か、`.gitignore` 済みの名前（`.dev.vars.production` など）に置いてください。

### 設定を変える

秘密ではない設定は、Worker の「設定」→「変数とシークレット」に、型を「変数」にして入れます。保存すると、その場で新しい版がデプロイされて効きます。そのあとのデプロイでも消えません（`wrangler.jsonc` の `keep_vars`）。入れなければ、既定で動きます。

| 名前 | 既定 | 中身 |
|---|---|---|
| `FETCH_INTERVAL_MINUTES` | 30 | フィードを取得する間隔（分）。[取得の間隔](#取得の間隔) |
| `ARTICLE_RETENTION_DAYS` | 90 | スターのない記事を消すまでの日数。[古い記事の片付け](#古い記事の片付け) |
| `PUBLIC_URL`、`READER_URL` | なし | OAuth で MCP につなぐときのオリジン。[OAuth でつなぐ](#oauth-でつなぐ) |

`PUBLIC_URL` と `READER_URL` を入れると OAuth が有効になり、動的登録を誰でも呼べるようになります。独自のドメインで動かすなら、レート制限のルールも作ってください（[OAuth でつなぐ](#oauth-でつなぐ)）。

fork の `wrangler.jsonc` には書かないでください。fork は公開されるので、自分の Sendo の URL が誰にでも見えてしまいます。画面に「これらの変更で Wrangler 設定を更新し、デプロイを同期させてください」と出ますが、写さなくてかまいません。

手元では、`pnpm dev --var FETCH_INTERVAL_MINUTES:60` のように入れます（`.dev.vars` からは、秘密の 3 つしか読まれません）。

### 更新する

GitHub の fork の画面で「Sync fork」→「Update branch」を押します。上流の変更が fork の `main` に入り、その push でデプロイされます（マイグレーションも当たります）。

自動で取り込みたいときは、[sendo-updater](https://github.com/sendo-feed/sendo-updater) も fork してデプロイします。毎分、自分の sendo と sendo-reader の fork を上流と比べ、遅れていれば取り込みます（sendo-reader は、sendo のデプロイが成功してから）。入れ方は sendo-updater の README にあります（[決定](docs/decisions/deploy.md)の 7）。

上流の更新によっては、Cloudflare の画面での準備（R2 を使えるようにする、など）が要ります。取り込んだあとのデプロイが止まったら、Workers Builds のログと、上の「初めてのデプロイ」を見て、準備してからビルドをやり直してください。

## コンテナ版で動かす

上流の CI が作ったイメージ（`ghcr.io/sendo-feed/sendo`）を、Docker Compose で動かします。fork もビルドも要りません（[決定](docs/decisions/container.md)の 10）。データ（SQLite のファイルと記事の本文）は、ボリュームの `/data` に置きます。

1. [compose.yaml](compose.yaml) と [.env.example](.env.example) を、置き場にするディレクトリに写す。`.env.example` は `.env` という名前にして、設定を書く（名前と意味は Cloudflare 版と同じ）
2. 動かす

   ```sh
   docker compose up -d
   ```

3. アクセストークンを発行する（ブラウザでログインしないで使うとき）

   ```sh
   docker compose exec sendo node dist/node/sendo.mjs token:create --email you@example.com
   # MCP 用なら --mcp（状態を変えるツールも使うなら --mcp --write）
   ```

`compose.yaml` は、同じマシンの `127.0.0.1:8787` にだけ出します。外から使うときは、手前にリバースプロキシ（Caddy など）を置いて TLS を終え、`.env` の `PUBLIC_URL` にそのオリジン（例：`https://sendo.example.com`）を入れてください。リクエストの URL がそのオリジンにそろい、Google のログインの戻り先や OAuth が正しく動きます。

上流の更新は、次で取り込みます。マイグレーションは、起動するときに当たります。

```sh
docker compose pull && docker compose up -d
```

> [!NOTE]
> リポジトリを公開するまでは、イメージも非公開です。取ってくるには、`docker login ghcr.io` で、`read:packages` の権限を持つ GitHub のトークンを使ってログインしてください。

手元でイメージを作るときは `docker build -t sendo .` で、作らずに Node で動かすときは `pnpm build:node` のあとに `DATA_DIR=./.data pnpm start:node` です。

## コマンド

| コマンド | すること |
|---|---|
| `pnpm dev` | 手元でサーバーを動かす |
| `pnpm check` | 型チェック、lint、Rust の検査、ネイティブのモジュールのビルド、テストをまとめて実行する（PR を出す前に） |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` | lint と整形の確認（Biome） |
| `pnpm format` | 整形して、直せる lint の指摘を直す |
| `pnpm test` | テスト（Workers のランタイムの中で動く。コンテナ版の緩衝層は Node で動く） |
| `pnpm build` | デプロイせずにバンドルだけ作って確かめる |
| `pnpm check:rust` | Rust（`crates/`）の整形の確認、lint（clippy）、テスト |
| `pnpm build:native` | Rust をネイティブのモジュール（`native/sendo.node`）にする（コンテナ版のテストの前に要る） |
| `pnpm build:node` | コンテナ版のバンドル（`dist/node/sendo.mjs`）を作る |
| `pnpm start:node` | コンテナ版を手元の Node で動かす（`DATA_DIR` にデータを置く） |
| `pnpm cf-typegen` | `wrangler.jsonc` から型（`worker-configuration.d.ts`）を作り直す |
| `pnpm openapi:generate` | API の定義を `spec/openapi.json` に書き出す（API を変えたらコミットする） |
| `pnpm db:generate` | `src/db/schema.ts` からマイグレーションの SQL を作る |
| `pnpm db:migrate:local` | 手元の D1 にマイグレーションを当てる |
| `pnpm db:migrate` | デプロイ先の D1 にマイグレーションを当てる |
| `pnpm run deploy` | デプロイする（[デプロイ](#デプロイ)。マイグレーションも当てる） |
| `pnpm token:create --email <メール>` | ユーザーとアクセストークンを作る（`--mcp` で MCP 用、`--remote` でデプロイ先） |

## ディレクトリ構成

```text
sendo/
├── src/
│   ├── index.ts        # Worker の入口（fetch ／ scheduled ／ queue）
│   ├── app.ts          # HTTP のルーティング
│   ├── api/            # REST API（/api/v1）
│   ├── auth/           # ログイン（OpenID Connect の提供元、ID トークンの確認）
│   ├── db/             # スキーマとデータの読み書き（Drizzle）。共有のフィード・記事と、人ごとの購読・受信箱
│   ├── feeds/          # 購読の手続き（REST API、Google Reader API で共通）
│   ├── fetcher/        # フィードの取得と解析、SSRF 対策
│   ├── greader/        # Google Reader API 互換（/accounts/ClientLogin、/reader/api/0）
│   ├── mcp/            # リモート MCP サーバー（/mcp）
│   ├── oauth/          # OAuth の認可サーバー（MCP 用。メタデータ、トークン、クライアントの登録）
│   ├── jobs/           # キューと定期実行で動く処理
│   ├── opml/           # OPML の読み書き
│   └── platform/       # 実行環境の緩衝層
│       ├── cloudflare/ # Cloudflare 版の実装（D1・Queues など）
│       └── node/       # コンテナ版の実装と入口（SQLite、ジョブの表など）
├── crates/             # Rust（コンテナ版の重い処理と、napi-rs の結び）
├── migrations/         # マイグレーション。2 つの版で同じものを使う（pnpm db:generate で作る）
├── spec/openapi.json   # API の定義（pnpm openapi:generate で書き出す。sendo-reader が型を作る）
├── test/               # テスト（Vitest ＋ Workers のランタイム。test/node/ は Node）
├── docs/
│   ├── decisions/      # 今の決定
│   ├── inception-deck.md
│   ├── tech-deck.md
│   └── features.md
├── wrangler.jsonc      # Cloudflare 版の設定
├── Dockerfile          # コンテナ版のイメージ（compose.yaml で動かす）
└── biome.json          # lint と整形の設定
```

機能を足すときのディレクトリの分け方は、[技術構成](docs/tech-deck.md#6-ディレクトリ構成sendo)にあります。

Cloudflare 固有の機能（`cloudflare:*`）に触れてよいのは `src/index.ts` と `src/platform/cloudflare/` だけで、Node.js の組み込みモジュール（`node:*`）を使ってよいのは `src/platform/node/` だけです。どちらも lint で検査しています（[決定](docs/decisions/tech-stack.md)）。

## 文書

- [インセプションデッキ](docs/inception-deck.md)：なぜ作るのか、何をやらないか
- [機能一覧](docs/features.md)：何を作るか
- [技術構成](docs/tech-deck.md)：どう作るか
- [決定の一覧](docs/decisions/README.md)：今の決定とその理由
- [コストの見積もり](docs/cost.md)：Cloudflare の無料プランと Workers Paid で、どれくらいの規模まで動かせるか

## 貢献

いまは2人で開発していて、外部からの Issue や PR は公開の準備ができてから受け付けます。決まりごとは [CONTRIBUTING.md](https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md) にあります。

## ライセンス

未定です。決まるまでは、すべての権利を留保します。
