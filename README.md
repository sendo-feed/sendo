# Sendo

> **鮮度を、導く。** — Fresh feeds, guided.

[![CI](https://github.com/sendo-feed/sendo/actions/workflows/ci.yml/badge.svg)](https://github.com/sendo-feed/sendo/actions/workflows/ci.yml)

Sendo は、オープンソースのフィード集約サーバーです。

- **API・MCP ファースト**：人もエージェントも、同じ入口からフィードを扱える
- **好きなリーダーで読める**：Google Reader API 互換で、Reeder や NetNewsWire がそのまま使える
- **自分で持てる**：セルフホストして、データも設定も手元に置ける

> [!NOTE]
> Phase 1（MVP）は完了し、Feedly の OPML を移して sendo-reader で毎日読む段階に入りました。いまは Phase 2 を進めています。記事のページからの全文抽出は実装済みです。[機能と達成状況](docs/features.md)

## 動かす

Sendo は、自分のサーバー（手元の PC、自宅のサーバー、VPS など）で、Docker で動かします（[決定](docs/decisions/container.md)）。上流の CI が作ったイメージ（`ghcr.io/sendo-feed/sendo` と、画面の `ghcr.io/sendo-feed/sendo-reader`）を、Docker Compose で並べて動かします。標準構成では fork もビルドも要りません（[決定](docs/decisions/container.md)の 7、10）。データ（SQLite のファイルと記事の本文）は、ボリュームの `/data` に置きます。

外に出すのは sendo-reader のコンテナだけです。sendo-reader が画面を返し、Sendo のパス（`/api`、`/mcp`、OAuth、Google Reader API など）を、compose の中の Sendo に中継します。画面、ブラウザのログイン、リーダーアプリ、MCP は同じ sendo-reader のオリジンを使います（[sendo-reader の決定](https://github.com/sendo-feed/sendo-reader/blob/main/docs/decisions/container.md)）。

1. [compose.yaml](compose.yaml) と [.env.example](.env.example) を、置き場にするディレクトリに写す。`.env.example` は `.env` という名前にして、設定を書く
   - `PUBLIC_URL` と `READER_URL`：どちらも、外から開く sendo-reader のオリジン（例：`https://reader.example.com`）。`PUBLIC_URL` は欠かせません。ないと、ブラウザのログインの戻り先が合いません。2 つとも入れると、OAuth（[OAuth でつなぐ](#oauth-でつなぐ)）も使えます
   - `ALLOWED_EMAILS`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`：ブラウザでログインするとき（[ブラウザでログインする](#ブラウザでログインするgoogle)）。Google の「承認済みのリダイレクト URI」には `https://reader.example.com/api/v1/auth/google/callback` を入れる
2. 手前にリバースプロキシ（Caddy など）か Cloudflare Tunnel を置いて TLS を終え、sendo-reader のコンテナ（`127.0.0.1:8080`）に向ける
   - 更新の知らせ（`/api/v1/sync/updates`）は WebSocket を使うので、手前のプロキシが `Upgrade` を通す必要があります（[決定](docs/decisions/sync.md)の 9）。Caddy（`reverse_proxy`）と Cloudflare Tunnel は、何も足さずに通します
   - nginx などでは、HTTP/1.1 で中継し、`Upgrade` と `Connection` のヘッダーを渡す設定が要ります

     ```nginx
     location = /api/v1/sync/updates {
         proxy_pass http://127.0.0.1:8080;
         proxy_http_version 1.1;
         proxy_set_header Upgrade $http_upgrade;
         proxy_set_header Connection "upgrade";
         proxy_set_header Host $host;
     }
     ```

   - 通さなくても、定期の同期だけで動きます。壊れはしませんが、別の端末や取得での変更が、開いている画面にすぐには反映されません
3. 動かす

   ```sh
   docker compose up -d
   ```

4. `https://reader.example.com` を開き、Google でログインする。ブラウザでログインしないで使うときは、アクセストークンを発行する

   ```sh
   docker compose exec sendo node dist/node/sendo.mjs token:create --email you@example.com
   # MCP 用なら --mcp（状態を変えるツールも使うなら --mcp --write）
   ```

リーダーアプリのサーバー（[リーダーアプリで読む](#リーダーアプリで読むgoogle-reader-api)）も、MCP の URL（`https://reader.example.com/mcp`）も、sendo-reader のオリジンにします。

画面を使わず、リーダーアプリや MCP だけで使うときは、`compose.yaml` の `reader` を消して Sendo のポートを出し（`compose.yaml` のコメント）、`PUBLIC_URL` を Sendo のオリジンにします。`READER_URL` は空にします（OAuth は使えず、MCP 用のトークンでつなぎます）。

### X の埋め込みを有効にする

X の埋め込みに対応した reader を用意し、[reader の手順](https://github.com/sendo-feed/sendo-reader#x-の投稿の埋め込み)に従って、埋め込み用の静的ファイルを別の HTTPS ホストに置き、reader のイメージを `sendo-reader:x-embeds` として作ります。Compose の置き場に `compose.override.yaml` を作り、`reader` のイメージを差し替えます。

```yaml
services:
  reader:
    image: sendo-reader:x-embeds
    pull_policy: never
```

初回は `docker compose pull sendo` で対応版の Sendo に更新してから、`docker compose up -d` で起動します。以後の更新でも Sendo のイメージを取り込み、reader のイメージをビルドし直してコンテナを作り直します。別ホストのファイルや配信用ヘッダーに変更があれば、reader と同じ版の `apps/web/x-embed/` を再配信します。旧 reader との互換性を保つ更新手順は [reader のコンテナ構成の決定](https://github.com/sendo-feed/sendo-reader/blob/main/docs/decisions/container.md#決定)に従います。

配備後は、新規のブラウザープロファイルで配備した reader を開き、対応版の Sendo が取得して保存した本文をオンラインで表示します。[投稿 ID が一意に決まる引用](https://github.com/sendo-feed/sendo-reader/blob/main/docs/decisions/local-first.md#記事の本文)までスクロールし、ウィジェットの表示、隔離フレームの接続先、専用 HTTPS ホストのルートのヘッダー（CSP と Referrer-Policy を含む）を照合します。[配備後の確認](docs/decisions/container.md#決定)

### 標準構成を更新する

上流の更新は、次で取り込みます。Sendo と sendo-reader が一緒に新しくなります。マイグレーションは、起動するときに当たります。

```sh
docker compose pull && docker compose up -d
```

設定（`.env`）を変えたら、`docker compose up -d` でコンテナを作り直すと効きます。入れなければ、既定で動きます。

| 名前 | 既定 | 中身 |
|---|---|---|
| `FETCH_INTERVAL_MINUTES` | 30 | フィードを取得する間隔の下限（分）。[取得の間隔](#取得の間隔) |
| `STORAGE_LIMIT_MIB` | 10240 | 記事と本文の保存容量（MiB）。[古い記事の片付け](#古い記事の片付け) |
| `PUBLIC_URL`、`READER_URL` | なし | 外から呼ぶときのオリジンと、sendo-reader のオリジン。[OAuth でつなぐ](#oauth-でつなぐ) |
| `ALLOWED_EMAILS`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | なし | ブラウザのログイン。[ブラウザでログインする](#ブラウザでログインするgoogle) |
| `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`DISCORD_BOT_TOKEN` | なし | Discord の購読。[Discord のチャンネルを購読する](#discord-のチャンネルを購読する) |

### 取得の間隔

フィードを取得する間隔の下限（分）は、`FETCH_INTERVAL_MINUTES` に入れます。10 以上の整数で、既定は 30 です。取得の時期が来たフィードは 10 分おきの定期実行が仕事に積むので、10 分より短くはできません（[決定](docs/decisions/jobs.md)）。

実際の間隔は、フィードごとに、直近 7 日の記事の出るペースから決まります（記事の平均の間隔の 3 分の 1）。記事の多いフィードは設定の間隔で、静かなフィードは最長で 1 日おきに取得します。429 ／ 503 の応答に `Retry-After` が付いていれば、その時刻（1 日まで）より前には取りにいきません。長く取得に失敗したフィードや HTTP 410 が返ったフィードは、週 1 回確認します。

### 古い記事の片付け

記事と本文は、設定した保存容量に収まる限り残します。保存日数による削除はしません。使用量が上限の 90% に達すると、80% 以下を目指し、取り込んだ時刻の古い記事から片付けます。未読も対象ですが、誰かがスターを付けている記事と、フィードにまだ載っている記事は残します（[決定](docs/decisions/retention.md)）。

`STORAGE_LIMIT_MIB` に MiB（1,048,576 バイト）の整数を設定します。最小は 16 MiB、既定は 10240 MiB（10 GiB）です。例えば、20 GiB にするなら `.env` に `STORAGE_LIMIT_MIB=20480` と書き、コンテナを作り直します。従来の `ARTICLE_RETENTION_DAYS` は使いません。誤った容量設定はエラーにし、小さい既定値への差し戻しによる削除を防ぎます。

容量は、記事の文字列、フィード本文、抽出本文に、DB の行と索引の見積もりを足した値です。DB ファイルの大きさを直接制限するものではありません。WAL、バックアップ、認証や設定などは別なので、配置先の空きを十分に残してください。削除した SQLite の領域は、後の書き込みで再利用されます。

移行時は、既存の本文を少しずつ集計します。集計が終わるまで既存記事は読めますが、容量による削除と新しい記事・本文の取り込みは待ちます。容量が足りなくなった場合も、既存記事は読めます。管理者向けログに `storage_limit_reached` を出し、空きができれば取り込みを再開します。記事の削除前のアーカイブは行いません。

受信箱の削除記録は、記事の保管とは別に、同期のため 30 日残します。古いカーソルを持つ端末は同期し直します。

## 手元で動かす

必要なもの：

- Node.js 22.21 以上の 22 系、または 24.9 以上（CI は [.node-version](.node-version) のバージョンで動かす）
- pnpm（バージョンは [package.json](package.json) の `packageManager` で固定している）
- Rust（ページの本文の抽出や言語の判定などの重い処理。rustup を入れておけば、[rust-toolchain.toml](rust-toolchain.toml) の版が自動で使われる）

pnpm は corepack で入れると、決められたバージョンが自動で使われます。Windows では、WSL の中（Linux 側のファイルシステム）にクローンするのがおすすめです。

```sh
corepack enable pnpm
```

```sh
git clone https://github.com/sendo-feed/sendo.git
cd sendo
pnpm install
pnpm build:native                             # Rust の処理をネイティブのモジュールにする
cp .env.example .env                          # 設定（なくても動く）
pnpm token:create --email you@example.com     # ユーザーとアクセストークンを作る
pnpm dev
```

`pnpm dev` は、ソースを [tsx](https://tsx.is/) でそのまま動かし、変更を見て動かし直します（`http://localhost:8787`）。`.env` があれば読みます。データは `.data/` に置き、マイグレーションは起動時に当てます。Rust のモジュールがなければ起動しないので、先に `pnpm build:native` を実行します（`crates/` を変えたときも）。

`pnpm token:create` は、ユーザーがいなければ作り、アクセストークン（`sendo_` で始まる文字列）を発行します。トークンは一度だけ表示されるので、控えておいてください。DB にはハッシュだけを置きます。

REST API は、次のように試せます。

```sh
TOKEN=sendo_...   # pnpm token:create で発行したトークン

# フィードを購読する。サイトの URL でもよい（ページからフィードを見つける）
curl -X POST http://localhost:8787/api/v1/feeds \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"url":"https://blog.cloudflare.com/"}'

# 未読の記事を新しい順に読む（state=starred ならスター付き、folderId ／ feedId で絞り込める）
curl -H "authorization: Bearer $TOKEN" "http://localhost:8787/api/v1/articles?state=unread&limit=10"

# 記事の本文を読む。source=page で、記事のページから抜いた本文
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

ページから抜いた本文は、サニタイズしてタグと文字参照を処理したあとの文字数が 100 文字未満なら、取得失敗として扱います。サイト紹介やコメント欄の案内だけを本文として保存するのを減らすためです。短い正規の記事も対象になるので、そのときはフィードの本文か要約を使ってください。`source=page` は 404（`page_content_unavailable`）を返し、1 日たってから呼ぶと取りにいき直します。

## 使い方

### ブラウザでログインする（Google）

ブラウザ（sendo-reader）からは、Google でログインしてセッションのクッキーで使います。設定しなければ、ブラウザのログインは使えず、アクセストークンだけで使います。

1. [Google Cloud のコンソール](https://console.cloud.google.com/apis/credentials)で OAuth クライアント（種類は「ウェブ アプリケーション」）を作る。「承認済みのリダイレクト URI」には、ブラウザから見た `<オリジン>/api/v1/auth/google/callback` を登録する（手元の sendo-reader なら `http://localhost:5173/api/v1/auth/google/callback`、本番なら sendo-reader のオリジン）
2. `.env` に、`ALLOWED_EMAILS`（ユーザーになれるメール）、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` を書く
3. ブラウザで `<オリジン>/api/v1/auth/google/login` を開く。ログインできたら `/` に戻る（`?returnTo=/パス` で戻る先を変えられる）。できなければ `/?login_error=<理由>` に戻る

許可したメールの人が初めてログインすると、ユーザーを作ります。同じメールのユーザー（`pnpm token:create` で作った人など）がいれば、そのユーザーに結び付けます。

ログインしたら、アクセストークン（リーダーアプリのアプリ用パスワード）を `/api/v1/tokens` で発行・一覧・取り消しできます。これはブラウザのセッションでだけ使え、アクセストークンでは使えません（漏れたトークンで新しいトークンを発行させないため）。

### Discord のチャンネルを購読する

管理者が追加した Discord Bot で、指定したテキストチャンネルとアナウンスチャンネルの新着を受信箱に取り込みます。投稿のテキストと元投稿へのリンクが記事に並びます。添付ファイルや会話は Discord で開きます。

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作り、サーバーへのインストールと、Bot の **Message Content Intent** を有効にします。OAuth2 のリダイレクト先に `<READER_URL>/api/v1/integrations/discord/callback` を登録します。
2. `.env` に `DISCORD_CLIENT_ID`（Application ID）、`DISCORD_CLIENT_SECRET`、`DISCORD_BOT_TOKEN`、`READER_URL` を設定します。
3. `GET /api/v1/integrations/discord` が返す `inviteUrl` をサーバーの管理者が開いて Bot を追加します。Bot に購読するチャンネルの「チャンネルを見る」と「メッセージ履歴を読む」を許可します。
4. ブラウザで Sendo にログインし、`POST /api/v1/integrations/discord/connect` の `authorizationUrl` を開いて Discord アカウントを接続します。`POST /api/v1/integrations/discord/subscriptions` にチャンネル URL を渡すと、その時点からの新着を取得します。接続と購読の API は [OpenAPI](spec/openapi.json) にあります。

購読の解除、Discord 連携の解除、取得時に Discord 側の閲覧権限がなくなったことを検出した場合は、取り込んだ記事をスター付きも含めて削除します。

### リーダーアプリで読む（Google Reader API）

Reeder、NetNewsWire など、Google Reader API（FreshRSS 互換）に対応したリーダーアプリから読めます。アカウントの種類は「FreshRSS」か「Google Reader API」を選び、次のように入れます。

| 項目 | 値 |
|---|---|
| サーバー（URL） | Sendo の URL（手元なら `http://localhost:8787`） |
| ユーザー名 | ユーザーのメールアドレス |
| パスワード | アクセストークン（`sendo_` で始まるもの）。ブラウザでログインして `/api/v1/tokens` で発行するか、`pnpm token:create` で発行する。アプリごとに発行すると、あとで個別に取り消せる |

既読・スター・購読・フォルダの変更は、REST API や sendo-reader と同じデータに反映されます。

### AI エージェントからつなぐ（MCP）

`/mcp` にリモート MCP サーバーがあります（[決定](docs/decisions/mcp.md)）。ツールは `list_feeds`、`list_folders`、`list_articles`、`get_unread`、`get_article`（読む）と、`subscribe`、`move_feed`、`unsubscribe`、`mark_read`、`star`（変える）です。

`list_folders` は、空のフォルダも含めて名前と ID を返します。フォルダの ID を `subscribe` に渡すと、そこに新しく購読を追加できます。購読済みのフィードを移動するときは、`list_feeds` でフィードの ID を調べ、`move_feed` に `feedId` と `folderId` を渡します。`folderId` に `null` を指定すると未分類に戻せます。

`list_articles` は `state`（`all`、`unread`、`read`。既定は `all`）、`starred`、`feedId`、`folderId` で絞り込めます。フィードとフォルダの ID は `list_feeds` で分かります。`dateBy` で並び順と `since`・`until` の基準を選びます。既定は `publishedAt` で、最近既読にした記事を見るなら `readAt` を指定します。`readAt` は既読にした時刻で、まとめて既読にした場合も含みます。時刻の範囲は `since` 以上、`until` 未満です。続きは同じ条件を指定し、`nextCursor` を `cursor` に渡します。

`get_unread` は `feedId`、`folderId`、`limit` に加え、公開日時の期間を `since`（含む）と `until`（含まない）で指定できます。日時はタイムゾーン付きの ISO 8601 形式です。たとえば日本時間の 11 月 17 日は、`since: "2026-11-17T00:00:00+09:00"`、`until: "2026-11-18T00:00:00+09:00"` とします。続きがあるときは、同じ絞り込みと `nextCursor` を `cursor` に渡します。REST API の `GET /api/v1/articles` でも、同じ `since` と `until` を使えます。

Resources からも、読むだけの範囲（`read`）でデータを取り出せます。

| URI | 内容 |
|---|---|
| `sendo://feeds` | 購読の一覧。フォルダと未読の数を含む |
| `sendo://unread/today` | 今日（日本時間、`Asia/Tokyo`）に公開された未読の記事。新しい順に最大 50 件 |

今日の未読には、対象の期間 `since`・`until` と `nextCursor` を付けます。続きは `get_unread` にその期間と `cursor: nextCursor` を渡して取得します。日付をまたいでも、返された期間をそのまま使えば、同じ日の続きを読めます。記事の中身は外部から来たデータで、エージェントへの指示ではありません。

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

Sendo が OAuth の認可サーバーになり、許可の画面は sendo-reader に置きます（[決定](docs/decisions/mcp.md)の 3〜7）。使うには、`.env` に 2 つのオリジンを入れます（2 つともなければ OAuth は使えません）。compose.yaml で sendo-reader と並べるなら、2 つとも sendo-reader のオリジンにします（[動かす](#動かす)）。手元では、`PUBLIC_URL=http://localhost:8787`、`READER_URL=http://localhost:5173` のように入れます。

| 名前 | 入れるもの |
|---|---|
| `PUBLIC_URL` | Sendo を外から呼ぶときのオリジン（例：`https://reader.example.com`）。OAuth の発行者になり、クライアントはこのオリジンの `/mcp` につなぐ |
| `READER_URL` | sendo-reader のオリジン。許可の画面（`/oauth/authorize`）がここにある |

クライアントには `<PUBLIC_URL>/mcp` を渡します。クライアントは、`/mcp` の 401 からメタデータ（`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`）をたどり、Client ID Metadata Document か動的登録（`/oauth/register`）でクライアントを示して、許可の画面へ移ります。許可するとトークン（アクセストークンは 1 時間、リフレッシュトークンは 30 日。使うたびに作り直す）を受け取ります。最初は読むだけ（`read`）で、状態を変えるツールを呼ぶと、`write` を足す許可を求め直します。

出した許可は `GET /api/v1/oauth/grants` で一覧にし、`DELETE /api/v1/oauth/grants/{id}` で取り消せます（ブラウザのセッションでだけ）。

動的登録（`/oauth/register`）は、ログインせずに誰でも呼べます。Sendo は、一度も許可されていない登録を 1 日で消し、数も 100 件までにします（超えたら 429 で断る。[決定](docs/decisions/mcp.md)の 5）。連打されても、データベースの容量や書き込みを使い切ることはありません。その間は、動的登録のクライアントが新しくつなげなくなりますが、Client ID Metadata Document のクライアントと MCP 用のトークンは使えます。

手前のリバースプロキシ（Caddy のレート制限のプラグインなど）で `/oauth/register` へのリクエストの回数を絞ると、守りを重ねられます。

## コマンド

| コマンド | すること |
|---|---|
| `pnpm dev` | 手元でサーバーを動かす（`.env` を読み、データは `.data/`） |
| `pnpm check` | 型チェック、lint、Rust の検査、ネイティブのモジュールのビルド、テストをまとめて実行する（PR を出す前に） |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` | lint と整形の確認（Biome） |
| `pnpm format` | 整形して、直せる lint の指摘を直す |
| `pnpm test` | テスト（Vitest。テストファイルごとに一時ディレクトリの SQLite を使う） |
| `pnpm check:rust` | Rust（`crates/`）の整形の確認、lint（clippy）、テスト |
| `pnpm build:native` | Rust をネイティブのモジュール（`native/sendo.node`）にする（`pnpm dev` とテストの前に要る） |
| `pnpm build` | バンドル（`dist/node/sendo.mjs`）を作る |
| `pnpm start` | バンドルを手元の Node で動かす（`DATA_DIR` にデータを置く） |
| `pnpm openapi:generate` | API の定義を `spec/openapi.json` に書き出す（API を変えたらコミットする） |
| `pnpm db:generate` | `src/db/schema.ts` からマイグレーションの SQL を作る（起動時に当たる） |
| `pnpm token:create --email <メール>` | 手元の DB に、ユーザーとアクセストークンを作る（`--mcp` で MCP 用） |

手元でイメージを作るときは `docker build -t sendo .` です。

## ディレクトリ構成

```text
sendo/
├── src/
│   ├── app.ts          # HTTP のルーティング
│   ├── api/            # REST API（/api/v1）
│   ├── auth/           # ログイン（OpenID Connect の提供元、ID トークンの確認）
│   ├── db/             # スキーマとデータの読み書き（Drizzle）。共有のフィード・記事と、人ごとの購読・受信箱
│   ├── discord/        # Discord の API の呼び出し
│   ├── feeds/          # 購読の手続き（REST API、Google Reader API で共通）
│   ├── fetcher/        # フィードの取得と解析、SSRF 対策
│   ├── greader/        # Google Reader API 互換（/accounts/ClientLogin、/reader/api/0）
│   ├── mcp/            # リモート MCP サーバー（/mcp）
│   ├── oauth/          # OAuth の認可サーバー（MCP 用。メタデータ、トークン、クライアントの登録）
│   ├── jobs/           # 仕事の表と定期実行で動く処理
│   ├── opml/           # OPML の読み書き
│   └── platform/       # 緩衝層（実行環境の入出力）のインターフェース
│       └── node/       # 緩衝層の実装と入口（SQLite、ファイル、ジョブの表、Rust の読み込み）
├── crates/             # Rust（重い処理と、napi-rs の結び）
├── migrations/         # マイグレーション（pnpm db:generate で作る。起動時に当たる）
├── spec/openapi.json   # API の定義（pnpm openapi:generate で書き出す。sendo-reader が型を作る）
├── test/               # テスト（Vitest）
├── docs/
│   ├── decisions/      # 今の決定
│   ├── inception-deck.md
│   ├── tech-deck.md
│   └── features.md
├── Dockerfile          # イメージ（compose.yaml で動かす）
├── compose.yaml        # Sendo と sendo-reader を並べて動かす
└── biome.json          # lint と整形の設定
```

機能を足すときのディレクトリの分け方は、[技術構成](docs/tech-deck.md#6-ディレクトリ構成sendo)にあります。

Node.js の組み込みモジュール（`node:*`）と `process` を使ってよいのは `src/platform/node/` だけです。lint で検査しています（[決定](docs/decisions/tech-stack.md)）。

## 文書

- [インセプションデッキ](docs/inception-deck.md)：なぜ作るのか、何をやらないか
- [機能一覧](docs/features.md)：何を作るか
- [技術構成](docs/tech-deck.md)：どう作るか
- [決定の一覧](docs/decisions/README.md)：今の決定とその理由

## 貢献

いまは2人で開発していて、外部からの Issue や PR は公開の準備ができてから受け付けます。決まりごとは [CONTRIBUTING.md](https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md) にあります。

## ライセンス

未定です。決まるまでは、すべての権利を留保します。
