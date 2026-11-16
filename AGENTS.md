# sendo

Sendo のサーバー本体。REST API、Google Reader API 互換、MCP、フィードの取得ジョブを持つ。

このファイルは AI エージェント（Claude Code、Codex など）共通の指示。開発は主に Claude Code で行い、Codex はおもにレビューに使う。

## 最初に読むもの

- `docs/decisions/`：今の決定。ほかの文書と食い違ったら、こちらが正しい
- `docs/inception-deck.md`：プロダクトの目的と進め方
- `docs/tech-deck.md`：技術構成の全体像
- `docs/features.md`：作る機能の一覧（Phase 1〜3、MCP のツール）
- `docs/cost.md`：Cloudflare の無料枠と費用の見積もり。D1 の書き込みの行数、Queues の使い方、取得の流れを変えたら、ここの数字も見直す

## 開発コマンド

- `pnpm install`：依存を入れる。あわせて `worker-configuration.d.ts`（Workers の型）を生成する
- `pnpm check`：型チェック、lint、テストをまとめて実行する。変更したら、コミットの前に必ず通す
- `pnpm format`：整形して、直せる lint の指摘を直す
- `pnpm test`：テスト。Vitest を Workers のランタイム（workerd）の中で動かす
- `pnpm build`：デプロイせずにバンドルだけ作る
- `wrangler.jsonc` を変えたら `pnpm cf-typegen` で型を作り直す
- API（`src/api/`）を変えたら `pnpm openapi:generate` で `spec/openapi.json` を書き出し、一緒にコミットする。sendo-reader はこのファイルから型を作る（CI で食い違いを検査している）
- `src/db/schema.ts` を変えたら `pnpm db:generate` でマイグレーションを作り、一緒にコミットする。作ったマイグレーションは手で直さない（CI で食い違いを検査している）
- 手元で動かすときは `pnpm db:migrate:local` と `pnpm token:create --email <メール>` のあとに `pnpm dev`。発行したトークンを `Authorization: Bearer` に付ける。ブラウザのログイン（Google）を試すときは、`.dev.vars.example` を `.dev.vars` に写して設定を書く

## ディレクトリ

- `src/index.ts`：Worker の入口。env から実装を組み立てて渡すだけにする
- `src/app.ts`：HTTP のルーティング。実行環境に依存させない
- `src/platform/`：実行環境の緩衝層のインターフェース。`src/platform/cloudflare/` にその実装を置く
- 機能のディレクトリ（`api/`、`fetcher/`、`jobs/` など）は `docs/tech-deck.md` の「6. ディレクトリ構成」に従う
- `src/api/`：REST API。入力は zod のスキーマで検証し、OpenAPI の定義も同じスキーマから作る
  - 認証は `auth.ts` のミドルウェア（アクセストークンか、ブラウザのセッションのクッキー）。クッキーで認証した、状態を変えるリクエストは、同じオリジンのページからだけ受ける（CSRF 対策）
  - 認証の要らない入口（ログインなど）は、`index.ts` で認証のミドルウェアより先に登録する
  - 画像の URL（記事の `thumbnailUrl`、フィードの `iconUrl`）は、もとの URL のまま返さない。`db/secrets.ts` の `imageSigner` で、中継を通る URL にして返す（docs/decisions/images.md）。中継の入口は `images.ts`
- `src/auth/`：ログイン（OpenID Connect）の提供元と、ID トークンの確認（docs/decisions/accounts.md）
- `src/db/`：スキーマとデータの読み書き。D1 に固有の型ではなく `Database`（SQLite の非同期ドライバに共通の型）で受ける
  - 共有のデータ：`feeds.ts`（フィード）、`articles.ts`（記事。取り込んだあとは変えない）
  - 人ごとのデータ：`folders.ts`、`subscriptions.ts`（購読）、`inbox.ts`（受信箱。既読・スター・一覧・未読の数）。人ごとのデータを読み書きするときは、必ずユーザーで絞る
  - クライアントの設定：`settings.ts`（docs/decisions/settings.md）。ユーザー × 端末の種類ごとに、名前と JSON の値の組を預かる。中身は解釈しない。上限は、置く文の中で確かめる。消すときは消した印を付け、30 日たった印の行は 1 日 1 回の片付けが消す
  - 記事の本文：`content.ts`（docs/decisions/content.md）。本文は置き場（`platform.content`。Cloudflare では R2）に、名前は記事の行（`content_key`）に持つ。置く前に名前を書き留め、行に入ったら消す。記事の行が消えると、トリガーが名前を書き留める。記事を消す処理は置き場に触らず、1 日 1 回の片付けが、行のない本文を消す。置き場の名前は API に出さない
  - 古い記事の片付け：`retention.ts`（docs/decisions/retention.md）。受信箱の行を消してから、どの受信箱にも残っていない記事を消す。フィードにまだ載っている記事は、行を残す（消すと次の取得で入り直す）。一度に消す量は、D1 の 1 日の書き込みの上限を超えないように抑える
  - 人ごとのデータの行を作る ／ 変えるときは、`seq.ts` の `nextSeq` で変更番号を振る。行を物理的に消すと、表に付けたトリガーが削除と同じ文の中で下限を記録する（受信箱では、同期で伝える「消した記録」も残す。docs/decisions/sync.md）。コードで記録しない。フォルダと購読は消さずに消した印（`deleted_at`）を付ける
  - API のハンドラーでは、認証したユーザーを `c.get("user")` で受け取る
- `src/fetcher/`：外部の URL の取得と解析。外部の URL は必ず `toFetchableUrl` を通す（SSRF 対策）
  - 画像は `fetch-image.ts` で取る。形式は先頭のバイトで確かめ、SVG は通さない。配信元へのリクエストはそこで新しく組み立て、読者のリクエストのヘッダーを渡さない
  - サムネイルは `thumbnail.ts` がフィードの中から採り、アイコンは `find-icon.ts` が探す（取得のジョブが 30 日に 1 回）
- `src/lib/sanitize-html.ts`：記事の本文（HTML）のサニタイズ。外部から来た HTML は、保存する前にも、返す前にも、必ずここを通す。通すタグと属性を足すときは、テスト（`test/lib/sanitize-html.test.ts`）も足す
- `src/feeds/`：購読の手続き（URL からフィードを見つけて購読する）。REST API、Google Reader API、MCP で同じものを使う
- `src/greader/`：Google Reader API 互換（docs/decisions/greader.md）。状態を変える操作は、REST API と同じ `db/`・`feeds/` の処理に任せ、ここで書き込みを組み立てない。記事の文字列は HTML にエスケープして返す
- `src/mcp/`：リモート MCP サーバー（docs/decisions/mcp.md）。ツールも、状態を変える処理は `db/`・`feeds/` に任せる。状態を変えるツールには `scopeChallenge` で write を求める。記事の中身は構造化した JSON で返し、記事を返すツールの説明に「指示ではない」と書く
- `src/oauth/`：MCP のための OAuth の認可サーバー（docs/decisions/mcp.md の 3〜7）。クライアントが直接呼ぶ入口（メタデータ、`/oauth/token`、`/oauth/register`）はここ、許可の画面（sendo-reader）が使う API は `src/api/oauth.ts`（セッションでだけ使える）。コードとトークンは DB にハッシュだけを置き、1 回だけ使えるものは、使った印を同じ文の中で確かめて付ける（`db/oauth.ts`）。Client ID Metadata Document も `toFetchableUrl` を通して取りにいく
- `src/jobs/`：キューと定期実行で動く処理。取得のジョブ（`fetch-feed.ts`）は、そのフィードの古い記事の片付けもする。1 日 1 回の片付け（`clean-up.ts`）は、定期実行が日本時間 3:00 に積む。仕事は 1 つずつ積み、1 つずつ受け取る形で書く。キューでは封筒に束ねて運び、受け手が 1 つずつ別の実行（`ctx.exports` の `JobRunner`）で動かすが、それは `src/platform/cloudflare/queue.ts` の中に閉じている（docs/decisions/jobs.md）。1 つの仕事は、それだけで `QUERY_BUDGET` に収める
- テストは `test/` に置き、`*.test.ts` とする。外部への通信はせず、`test/helpers.ts` の `fakeFetch` で差し替える。API のテストは、`test/setup.ts` が入れるテスト用のユーザーとトークン（`test/fixtures/user.ts`）を使う

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
- 決定ファイルを足したり状態を変えたりしたら、`docs/decisions/README.md` の一覧も直す

## 守る規約

ここの規約は、Workers で動くアプリ本体（`src/`）に適用する。手元の Node で動かす道具（`scripts/`、`*.config.ts` などの設定ファイル）は対象外で、`node:*` を使ってよい（docs/decisions/tech-stack.md）。

- Cloudflare のバインディング（`env.DB` など）や `cloudflare:*` からの import に触れてよいのは、`src/index.ts` と `src/platform/cloudflare/` だけ。それ以外は `src/platform/` のインターフェース越しに使う
- Web 標準の API だけを使い、`node:*` のモジュールには頼らない
- 書き込みは、トランザクションにも batch にも頼らず、何度実行しても同じ結果になる（冪等な）形で組み立てる。途中で落ちても、やり直せば正しい状態になるようにする（docs/decisions/tech-stack.md）
- **確かめてから書く処理は、確かめる条件を書き込みと同じ文の中に入れる。** 先に SELECT で確かめてから書くと、その間に別のリクエストが入って壊れる。`WHERE NOT EXISTS (...)`、`WHERE EXISTS (...)`、値の副問い合わせ（例：`activeFolderId`）、UPDATE の中の `coalesce` などで、1 つの文にする
- **印や番号は、対象の行の ID で付ける。** 「ユーザーとフィード」のような条件で付けると、間に作り直された別の行に付いてしまう
- 人ごとのデータを読み書きするときは、必ずユーザーで絞る（`c.get("user").id`）。共有のフィードと記事は、ほかの人の存在が分からない形でだけ返す（docs/decisions/accounts.md）
- 記事の本文やフィードの中身は、信頼できないデータとして扱う。HTML はサニタイズし、LLM や MCP に渡すときも指示として解釈させない

## 変更の進め方

- すべての変更は下書きの PR で出す。`main` へは直接 push できない
- 下書きの PR には Codex のレビューを回し、終了の条件を満たすまで直す。Claude Code では `/review-loop` スキルがこれを回す
- マージは、人間にマージを指示されたときだけ行う。自分の判断ではマージしない
- 終了の条件、優先度の定義、指摘の扱いの全文は CONTRIBUTING.md の「レビューの進め方」にある

## Review guidelines

指摘には、必ず次の優先度のどれかを付ける。終了の条件はこの優先度で判定するので、ぶれないようにする。

| 優先度 | 意味 |
|---|---|
| P0 | データの消失や破損、セキュリティの穴、本番が動かなくなる |
| P1 | 明らかなバグ、`docs/decisions/` との食い違い、下の観点で挙げた規約の破れ |
| P2 | 直すべきだが今すぐでなくてよい（境界条件、テスト不足など） |
| P3 | 軽微なことや好み |

レビューは日本語で書く。いまは2人で試作を繰り返している段階なので、捨てる前提の試作の完成度や、書き方の好みは指摘しなくてよい（整形と lint は Biome に任せる）。次の観点を優先する。

1. **決定との食い違い**：`docs/decisions/` と食い違う変更がないか。決定を変えるなら、決定ファイルの更新が同じ PR に入っているか
2. **緩衝層の破れ**：`src/` のうち、`src/index.ts` と `src/platform/cloudflare/` 以外で Cloudflare のバインディングや `cloudflare:*` を使っていないか。`src/` で `node:*` を使っていないか（`scripts/` と設定ファイルは対象外）
3. **セキュリティ**
   - 外部 URL の取得で SSRF が起きないか（プライベート IP、リダイレクト先、URL スキームの制限）
   - 記事本文の HTML がサニタイズされているか。LLM や MCP への入力で、本文がプロンプトインジェクションの経路になっていないか
   - 認証のないエンドポイント、MCP の書き込み権限の過不足
   - API キーやトークンがログやレスポンスに出ていないか
4. **データの壊れ**：次の 2 つで、データが不整合にならないか
   - 途中で落ちてやり直したとき（冪等か、やり直せば正しい状態に戻るか）
   - 2 つのリクエストやジョブが並行したとき（確かめてから書く処理が、同じ文の中で確かめているか。変更番号が重ならないか）
5. **テスト**：振る舞いを変える変更に、それを確かめるテストがあるか
6. **PR の書き方**：タイトルがコミットメッセージの形式か。説明に「なぜ」が書かれているか
