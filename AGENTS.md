# sendo

Sendo のサーバー本体。REST API、MCP、フィードの取得ジョブを持つ。

このファイルは AI エージェント（Claude Code、Codex など）共通の指示。開発は主に Claude Code で行い、Codex はおもにレビューに使う。

## 最初に読むもの

- [決定の残し方](docs/decisions/documentation.md)。決定文書を編集・レビューする前に必ず読む
- [決定の一覧](docs/decisions/README.md)と作業に関係する決定。ほかの文書と食い違ったら、決定を正とする
- `docs/inception-deck.md`：プロダクトの目的と進め方
- `docs/tech-deck.md`：技術構成の全体像
- `docs/features.md`：作る機能の一覧（Phase 1〜3、MCP のツール）

## 開発コマンド

- `pnpm install`：依存を入れる
- `pnpm check`：型チェック、lint、Rust の検査（`pnpm check:rust`：rustfmt、clippy、cargo test）、ネイティブのモジュールのビルド、テストをまとめて実行する。変更したら、コミットの前に必ず通す
- `pnpm format`：整形して、直せる lint の指摘を直す
- `pnpm test`：テスト（Vitest、Node）。テストファイルごとに一時ディレクトリの SQLite を開き、マイグレーションを当てる（`test/db.ts`）。Rust を使うテストは `native/sendo.node` を読み込むので、先に `pnpm build:native` が要る
- `pnpm build:native`：Rust（`crates/`）を napi-rs のネイティブのモジュール（`native/sendo.node`）にする。`pnpm dev` とテストが読み込む
- `pnpm build`：バンドル（`dist/node/sendo.mjs`）を作る。`DATA_DIR=<ディレクトリ> pnpm start` で動かせる。イメージは `docker build -t sendo .`
- API（`src/api/`）を変えたら `pnpm openapi:generate` で `spec/openapi.json` を書き出し、一緒にコミットする。sendo-reader はこのファイルから型を作る（CI で食い違いを検査している）
- `src/db/schema.ts` を変えたら `pnpm db:generate` でマイグレーションを作り、一緒にコミットする。作ったマイグレーションは手で直さない（CI で食い違いを検査している）
- 手元で動かすときは `pnpm build:native` と `pnpm token:create --email <メール>` のあとに `pnpm dev`（`scripts/dev.mjs`。`.env` を読み、データは `.data/`、マイグレーションは起動時に当てる）。発行したトークンを `Authorization: Bearer` に付ける。ブラウザのログイン（Google）などを試すときは、`.env.example` を `.env` に写して設定を書く

## ディレクトリ

- `src/app.ts`：HTTP のルーティング。実行環境の入出力には直接触らず、`Platform` で受け取る
- `crates/`：重い処理（Rust。docs/decisions/tech-stack.md の 5）。処理の本体の crate（`extract/` など。`#![forbid(unsafe_code)]`）と、Node から呼ぶための結び（`node/`。napi-rs）を分ける。外への取得と DB には触らず、TypeScript の側からバイト列を受け取って結果を返す。重い処理は `AsyncTask` でスレッドプールに出す
- `src/platform/`：緩衝層。実行環境の入出力（DB、ファイル、外への取得、Rust のネイティブのモジュール、タイマー）をまとめる。インターフェースは `src/platform/index.ts`、実装と入口（`main.ts`）は `src/platform/node/` に置く（docs/decisions/tech-stack.md の 3、docs/decisions/container.md）。アプリはインターフェース越しに使い、テストでは差し替える。設定の読み方は `config.ts`
  - Rust の処理（`pageContent`、`languageDetection`）は `Platform` の必須の項目。読み込めなければ起動しない（docs/decisions/container.md の 2）
  - Rust のネイティブのモジュールを読み込むのは `src/platform/node/native.ts` だけ
- 機能のディレクトリ（`api/`、`fetcher/`、`jobs/` など）は `docs/tech-deck.md` の「6. ディレクトリ構成」に従う
- `src/api/`：REST API。入力は zod のスキーマで検証し、OpenAPI の定義も同じスキーマから作る
  - 翻訳や Discord のように設定で有無が分かれる機能は、その機能の API で伝える。機能の有無をまとめて返す API は持たない。新しい機能に対応する前の Sendo と組み合わさる間は、クライアントが呼んで失敗したら使わない形で扱う（docs/decisions/container.md の 3）
  - 認証は `auth.ts` のミドルウェア（アクセストークンか、ブラウザのセッションのクッキー）。クッキーで認証した、状態を変えるリクエストは、同じオリジンのページからだけ受ける（CSRF 対策）
  - 認証の要らない入口（ログインなど）は、`index.ts` で認証のミドルウェアより先に登録する
  - 状態を変えるリクエストが成功したら、`notify-changes.ts` のミドルウェアが、その利用者の通知の接続に知らせる（docs/decisions/sync.md の 9）。ハンドラーで知らせなくてよい。ミドルウェアを通らない MCP のツールとジョブで人ごとのデータを変えるときは、`lib/sync-notify.ts` の `notifySync` で知らせる。`db/` の書き込みの中では知らせない（取得のジョブが受信箱に配る `deliverNewArticles` だけは、配った先を知るので、受け取った `notify` で知らせる）
  - 画像の URL（記事の `thumbnailUrl`、フィードの `iconUrl`）は、もとの URL のまま返さない。`db/secrets.ts` の `imageSigner` で、中継を通る URL にして返す（docs/decisions/images.md）。中継の入口は `images.ts`
- `src/auth/`：ログイン（OpenID Connect）の提供元と、ID トークンの確認（docs/decisions/accounts.md）
- `src/db/`：スキーマとデータの読み書き。libsql に固有の型ではなく `Database`（SQLite の非同期ドライバに共通の型）で受ける。生の SQL で 1 行を読むときは、`db.get(sql)` ではなく `getRow`（`db/index.ts`）を使う（libsql の drizzle の `get` は、行が返らないと例外を投げる）
  - 共有のデータ：`feeds.ts`（フィード）、`articles.ts`（記事。取り込んだあとは変えない）
  - 人ごとのデータ：`folders.ts`、`subscriptions.ts`（購読）、`inbox.ts`（受信箱。既読・スター・一覧・未読の数）、`bells.ts`（通知のベル。docs/decisions/notifications.md。購読をやめると、トリガーがその購読のベルにも消した印を付ける）、`bell-notifications.ts`（通知の行。10 分の窓と 1 時間の上限を、行を作る文の中で DB の時計で数え、ベルが有効なことと、受信箱に記事が未読であることも同じ文で確かめる。同期しない）。人ごとのデータを読み書きするときは、必ずユーザーで絞る
  - クライアントの設定：`settings.ts`（docs/decisions/settings.md）。ユーザー × 端末の種類ごとに、名前と JSON の値の組を預かる。中身は解釈しない。上限は、置く文の中で確かめる。消すときは消した印を付け、30 日たった印の行は 1 日 1 回の片付けが消す
  - 記事の本文：`content.ts`（docs/decisions/content.md）。本文は置き場（`platform.content`。データのボリュームの上のファイル）に、名前は記事の行（`content_key`）に持つ。置く前に名前を書き留め、行に入ったら消す。記事の行が消えると、トリガーが名前を書き留める。記事を消す処理は置き場に触らず、1 日 1 回の片付けが、行のない本文を消す。置き場の名前は API に出さない
  - 古い記事の片付け：`retention.ts`（docs/decisions/retention.md）。受信箱の行を消してから、どの受信箱にも残っていない記事を消す。保存容量が圧迫したときだけ、古いスターなし記事を片付ける。スター付きとフィード掲載中の記事は保護する。`storage.ts` と DB のトリガーで使用量を集計し、保存前にも上限を確かめる。一度に消す量と 1 日の回数を抑える
  - 人ごとのデータの行を作る ／ 変えるときは、`seq.ts` の `nextSeq` で変更番号を振る。行を物理的に消すと、表に付けたトリガーが削除と同じ文の中で下限を記録する（受信箱では、同期で伝える「消した記録」も残す。docs/decisions/sync.md）。コードで記録しない。フォルダと購読は消さずに消した印（`deleted_at`）を付ける
  - API のハンドラーでは、認証したユーザーを `c.get("user")` で受け取る
- `src/fetcher/`：外部の URL の取得と解析。外部の URL は必ず `toFetchableUrl` を通す（SSRF 対策）
  - 画像は `fetch-image.ts` で取る。形式は先頭のバイトで確かめ、SVG は通さない。配信元へのリクエストはそこで新しく組み立て、読者のリクエストのヘッダーを渡さない
  - サムネイルは `thumbnail.ts` がフィードの中から採り、アイコンは `find-icon.ts` が探す（取得のジョブが 30 日に 1 回）
  - 記事のページの本文は `page-content.ts`（docs/decisions/content.md の 10〜21）。取得の仕事が新しい記事ごとに `extract-page` の仕事を積み、`fetch-page.ts` でページを取り、緩衝層の `pageContent`（Rust）で抜く。開いたときにまだなければ、そのリクエストの中で抜く。サニタイズした HTML は、置き場ではなく `db/page-contents.ts` の表の行に入れる
  - 記事のページを取りにいくときは、同じホストへは 1 本ずつ（`host-gate.ts`）にし、robots.txt を守る（`robots.ts`）。どちらもプロセスのメモリに持つ。フィードの取得には robots.txt を当てない
- `src/lib/sanitize-html.ts`：記事の本文（HTML）のサニタイズ。外部から来た HTML は、保存する前にも、返す前にも、必ずここを通す。通すタグと属性を足すときは、テスト（`test/lib/sanitize-html.test.ts`）も足す。計測用の画像（トラッキングピクセル）は `tracking-image.ts` で見分けて落とす。計測のアドレスの一覧もそこに持ち、出どころの確かなものだけを足す
- `src/feeds/`：購読の手続き（URL からフィードを見つけて購読する）。REST API と MCP で同じものを使う
- `src/notify/`：Web Push（docs/decisions/notifications.md の 14〜22）。暗号化は `web-push.ts`（RFC 8291）、VAPID の鍵と JWT は `vapid.ts`、通知の中身は `payload.ts`、登録の確かめは `registration.ts`。どれも Web Crypto で書く。ベルの言葉の受け方と当て方（6、7）は `words.ts` で、REST API と MCP で同じものを使う。判定と送る仕事は `jobs/bell-notifications.ts`。言葉の照合は、DB で候補のベルを引いてから TypeScript で行う。記事の文字は `jobs/bell-notifications.ts` の `judgedText` で作り、本文はプレーンテキストの先頭 20,000 コードポイントちょうどで切って、切った印を付けない（検索の索引の 19,999 文字と「…」の切り方とは違う。「…」は NFKC で「...」になり、言葉に当たるため）。切った位置の直後の 1 文字は、言葉のすぐあとに英数字があるかを見るためだけに残す。取得の仕事が配ったあとに判定し、送るのは端末ごとの仕事にして取り込みと切り離す。まとめの仕事は、窓の 4 件目（最初の bundled）の行を作ったときに、窓が閉じる時刻を指定して積む（定期実行では拾わない）。送り先は緩衝層の `fetch` で、リダイレクトを追わない
- `src/translation/`：記事の翻訳（docs/decisions/translation.md）。Claude API を呼ぶのは `claude.ts` だけで、公式の SDK（`@anthropic-ai/sdk`）に、緩衝層の `fetch` と、設定（`platform/config.ts` の `readTranslationConfig`）のキーを渡す。送り先・ログ・テレメトリ・webhook の鍵も明示して、SDK に環境変数を読ませない（`ANTHROPIC_CUSTOM_HEADERS` だけは SDK の設定で止められないので、コンテナに入れない）。訳文の行は `db/translations.ts`、状態は書き込みと同じ文で確かめて移す。仕事（決める、その場で訳す、止まったものを戻す、バッチで送り結果を書く）は `jobs/translations.ts`。記事の中身は訳すデータとして JSON で渡し、指示として扱わせない
- `src/mcp/`：リモート MCP サーバー（docs/decisions/mcp.md）。ツールも、状態を変える処理は `db/`・`feeds/` に任せる。状態を変えるツールには `scopeChallenge` で write を求める。記事の中身は構造化した JSON で返し、記事を返すツールの説明に「指示ではない」と書く
- `src/oauth/`：MCP のための OAuth の認可サーバー（docs/decisions/mcp.md の 3〜7）。クライアントが直接呼ぶ入口（メタデータ、`/oauth/token`、`/oauth/register`）はここ、許可の画面（sendo-reader）が使う API は `src/api/oauth.ts`（セッションでだけ使える）。コードとトークンは DB にハッシュだけを置き、1 回だけ使えるものは、使った印を同じ文の中で確かめて付ける（`db/oauth.ts`）。Client ID Metadata Document も `toFetchableUrl` を通して取りにいく
- `src/jobs/`：キューと定期実行で動く処理。取得のジョブ（`fetch-feed.ts`）は、そのフィードの古い記事の片付けもする。取得の間隔は、フィードごとに記事の出るペースから `fetch-interval.ts` で決め、記事の出る時刻に癖（枠）があれば `fetch-slots.ts` で枠の時刻に合わせる。429 ／ 503 の `Retry-After` を守る（docs/decisions/jobs.md の 7、8、11）。1 日 1 回の片付け（`clean-up.ts`）は、定期実行が日本時間 3:00 に積む。仕事は 1 つずつ積み、1 つずつ受け取る形で書く。仕事は SQLite の表（`job_queue`）に積み、同じプロセスで動かす（`src/platform/node/job-queue.ts`、docs/decisions/jobs.md）。定期実行の中身は `jobs/schedule.ts` の `runScheduled` で、プロセスの中のタイマー（`src/platform/node/scheduler.ts`）から呼ぶ。1 つの仕事が扱う量には上限を置き、残りは次の仕事か定期実行に回す（docs/decisions/jobs.md の 4）
- テストは `test/` に置き、`*.test.ts` とする。外部への通信はせず、`test/helpers.ts` の `fakeFetch` で差し替える。API のテストは、`test/db.ts` が入れるテスト用のユーザーとトークン（`test/fixtures/user.ts`）を使う。SQL をそのまま書いて DB を確かめるときは `test/db.ts` の `testDb`、文の直前に割り込むときは `test/helpers.ts` の `statementHook` を使う。緩衝層の実装のテストは `test/platform/node/` に置く

## 言語

- 文書、コミットメッセージ、PR、レビューコメントは日本語で書く（一般に公開したら英語に切り替える）
- 識別子は英語

## コミットメッセージ

Conventional Commits を土台にする。全文は https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md

- 形式：`<type>(<scope>): <件名>`。type は feat ／ fix ／ docs ／ decision ／ refactor ／ perf ／ test ／ build ／ ci ／ chore ／ revert
- 本文には「なぜ」を書く
- `docs/decisions/` を変えるときは `decision(<テーマ>): …` にし、本文に何をなぜ変えたかを書く。ほかの変更とは分けて単独の PR にする（スカッシュマージで PR が1つのコミットになるため）
- `main` に force push しない

## 決定の扱い

- 決定は `docs/decisions/<テーマ>.md` にテーマごとに置き、今の決定だけを書く。決定が変わったらファイルを書き換え、古い内容は残さない
- 経緯を聞かれたら `git log -p -- docs/decisions/<テーマ>.md` を読んで答える
- 決定を変えるときは、その決定を参照する文書も検索して読み、影響する記述を現行の決定にそろえる
- 決定ファイルを足す・消す・改名する場合や、状態・概要が変わる場合は、`docs/decisions/README.md` の一覧も直す

## 守る規約

ここの規約は、アプリ本体（`src/`）に適用する。手元の Node で動かす道具（`scripts/`、`*.config.ts` などの設定ファイル）は対象外で、`node:*` を使ってよい（docs/decisions/tech-stack.md）。

- 実行環境の入出力（ファイル、ソケット、ネイティブのモジュール、環境変数）に触れてよいのは、緩衝層の実装（`src/platform/node/`）だけ。それ以外は `src/platform/` のインターフェース越しに使い、Web 標準の API（`fetch`、Web Crypto など）で書く。`node:*` と `process` は Biome で禁じている
- 書き込みは、トランザクションにも batch にも頼らず、何度実行しても同じ結果になる（冪等な）形で組み立てる。途中で落ちても、やり直せば正しい状態になるようにする（docs/decisions/tech-stack.md）
- **確かめてから書く処理は、確かめる条件を書き込みと同じ文の中に入れる。** 先に SELECT で確かめてから書くと、その間に別のリクエストが入って壊れる。`WHERE NOT EXISTS (...)`、`WHERE EXISTS (...)`、値の副問い合わせ（例：`activeFolderId`）、UPDATE の中の `coalesce` などで、1 つの文にする
- **印や番号は、対象の行の ID で付ける。** 「ユーザーとフィード」のような条件で付けると、間に作り直された別の行に付いてしまう
- 人ごとのデータを読み書きするときは、必ずユーザーで絞る（`c.get("user").id`）。共有のフィードと記事は、ほかの人の存在が分からない形でだけ返す（docs/decisions/accounts.md）
- 記事の本文やフィードの中身は、信頼できないデータとして扱う。HTML はサニタイズし、LLM や MCP に渡すときも指示として解釈させない
- 外から呼ばれるパス（`src/app.ts` に登録するもの）を足したり変えたりしたら、sendo-reader の `apps/web/sendo-paths.ts` も直す。reader のコンテナがこの一覧のパスだけを sendo に中継する（sendo-reader の docs/decisions/container.md の 3）

## テスト

- 振る舞いを変える変更には、それを確かめるテストを足す
- テストは、本番と同じ道と順で呼ぶ。確かめたい処理は、本番の呼び出し元（REST API、MCP のツール、ジョブなど）と同じ入口から、本番と同じ順と状態で呼ぶ（本番で別の操作のあとに呼ばれる処理は、その操作のあとに呼ぶ）。前提の状態は、本番でその処理が呼ばれるときと同じにする。本番の操作で手軽に作れるものはその操作で作り、作るのに手間のかかる状態や、失敗・割り込みを起こすときだけ、直接の書き込みや差し替えを使う。本番と違う道や順を通ると、本番でだけ起きる不具合をテストが通してしまうため
- 正常の流れに加えて、次のうち当てはまるものを入れる
  - 途中で失敗する：失敗したあとに何が残るか、やり直すと正しい状態に戻るか
  - 境界のちょうど：上限・下限と同じ値、ゼロ、空
  - ほかの操作と重なる：処理の途中に、別のリクエストやジョブが入る

## 変更の進め方

- 作業の前に Issue を用意する。Issue が要るのは feat ／ fix ／ perf ／ 振る舞いが変わる refactor ／ decision。docs ／ ci ／ build ／ chore ／ test ／ 振る舞いを変えない refactor ／ Dependabot の PR には要らない
- 1 Issue ＝ 1 PR。1 本の PR に収まらない作業は、親 Issue（やりたいこと、やらないこと、サブ Issue の一覧と順番）とサブ Issue（PR と 1 対 1）に分ける。決定の変更は、それだけで 1 つの Issue（またはサブ Issue）にする
- 着手の判定：始める前に Issue を読み、「やりたいこと」「やらないこと」「受け入れ条件（確かめる入力と期待する結果、対象外）」が書かれていて、1 本の PR に収まることを確かめる。足りないときは始めず、足りない情報を人間に聞いて Issue に書き足す。ラベルや人間の了承は要らない。Issue はエージェントが書いてよい（テンプレートと同じ見出しで書く）
- 単位の分け方：新しく持つ状態（表、列、印、設定、仕事など）が 2 つ以上増え、片方の変化がもう片方に効く変更は、1 本の PR に収まりそうでも、着手の判定でサブ Issue に分ける。切るときは、受け入れ条件を書ける振る舞いごとに 1 本にし、使う側のない状態だけの PR は作らない。作り始めてから気づいたら、先に Issue を分ける。状態どうしの関わりが不具合になりやすく、1 本にまとめるとレビューで見つけきれないため
- 途中で受け入れ条件や範囲を変えたくなったら、先に Issue を直し、理由を添える。PR の説明だけを変えない
- すべての変更は下書きの PR で出す。`main` へは直接 push できない。Issue が要る変更の PR は、説明に `Closes #番号` を 1 つだけ書き、受け入れ条件を Issue から写す（正本は Issue）
- Codex に出す前に（下書きの PR を作る前に）自己レビューし、見つけたものを直してから出す。書いた側の考えを持ち込まないよう、差分と関係する決定だけを見て見直す。見る観点と終わり方は `.claude/skills/review-loop/SKILL.md` の手順 1。自己レビューはラウンドに数えない
- そのあと Codex のレビューを回し、終了の条件を満たすまで直す。Claude Code では `/review-loop` スキルが、自己レビューも含めてこれを回す
- マージは、人間にマージを指示されたときだけ行う。自分の判断ではマージしない
- レビューは 3 回で打ち切る。打ち切った PR では、同じループを続けない。人間が「そのまま受け入れる」か「捨ててやり直す」を選ぶ。やり直すときは、コードを引き継がず、PR を閉じて Issue に戻り、やりたいこと、受け入れ条件、単位を、この順に見直して直し、着手の判定をやり直してから `main` から作る
- Issue の決まりの全文は CONTRIBUTING.md の「始める前に」、終了の条件、打ち切りのあとの扱い、優先度の定義、指摘の扱いの全文は「レビューの進め方」にある。単位の分け方と自己レビューは、このリポジトリで試している決まりで、CONTRIBUTING.md にはまだない

## Code Review Rules

### 決定文書

- 実装の変更は、該当する決定ファイルと照合する。決定を変える場合は決定ファイルを単独の PR で更新し、実装の PR からその決定を参照する。
- 決定文書のレビューでは `docs/decisions/documentation.md` を読み、変更した決定を参照する文書と一覧も照合する。冒頭・理由・代替案・見直す条件に、旧仕様を現行として書いた記述や、実装済みの仕様を予定とした記述が残っていれば P1 とする。

### Review guidelines

指摘には、必ず次の優先度のどれかを付ける。終了の条件はこの優先度で判定するので、ぶれないようにする。

| 優先度 | 意味 |
|---|---|
| P0 | データの消失や破損、セキュリティの穴、本番が動かなくなる |
| P1 | 明らかなバグ、`docs/decisions/` との食い違い、下の観点で挙げた規約の破れ |
| P2 | 直すべきだが今すぐでなくてよい（境界条件、テスト不足など） |
| P3 | 軽微なことや好み |

PR の説明に `Closes #番号` があるときは、その Issue を読む。前提（やりたいこと、やらないこと、受け入れ条件）は Issue にあり、PR の説明の受け入れ条件はその写し（食い違ったら Issue を正とし、食い違いを P1 で指摘する）。受け入れ条件を「できた」の定義として読む。受け入れ条件の外の入力への指摘は、P0 でない限り P2 以下にする。「対象外」と「やらないこと」に書いたものは指摘しない。Issue が要る変更（feat ／ fix ／ perf ／ 振る舞いが変わる refactor ／ decision）の PR に Issue が結ばれていなければ、P1 とする。

レビューは日本語で書く。いまは2人で試作を繰り返している段階なので、捨てる前提の試作の完成度や、書き方の好みは指摘しなくてよい（整形と lint は Biome に任せる）。次の観点を優先する。

1. **緩衝層の破れ**：`src/` のうち、`src/platform/node/` 以外で `node:*`、`process`、ファイルやソケットを直接使っていないか（`scripts/` と設定ファイルは対象外）
2. **セキュリティ**
   - 外部 URL の取得で SSRF が起きないか（プライベート IP、リダイレクト先、URL スキームの制限）
   - 記事本文の HTML がサニタイズされているか。LLM や MCP への入力で、本文がプロンプトインジェクションの経路になっていないか
   - 認証のないエンドポイント、MCP の書き込み権限の過不足
   - API キーやトークンがログやレスポンスに出ていないか
3. **データの壊れ**：次の 2 つで、データが不整合にならないか
   - 途中で落ちてやり直したとき（冪等か、やり直せば正しい状態に戻るか）
   - 2 つのリクエストやジョブが並行したとき（確かめてから書く処理が、同じ文の中で確かめているか。変更番号が重ならないか）
4. **テスト**：振る舞いを変える変更に、それを確かめるテストがあるか
5. **PR の書き方**：タイトルがコミットメッセージの形式か。説明に「なぜ」が書かれているか
