# sendo

Sendo のサーバー本体。REST API、Google Reader API 互換、MCP、フィードの取得ジョブを持つ。

このファイルは AI エージェント（Claude Code、Codex など）共通の指示。開発は主に Claude Code で行い、Codex はおもにレビューに使う。

## 最初に読むもの

- `docs/decisions/`：今の決定。ほかの文書と食い違ったら、こちらが正しい
- `docs/inception-deck.md`：プロダクトの目的と進め方
- `docs/tech-deck.md`：技術構成の全体像
- `docs/features.md`：作る機能の一覧（Phase 1〜3、MCP のツール）

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

- Cloudflare のバインディング（`env.DB` など）や `cloudflare:*` からの import に触れてよいのは、`src/index.ts` と `src/platform/cloudflare/` だけ。それ以外は `src/platform/` のインターフェース越しに使う
- Web 標準の API だけを使い、`node:*` のモジュールには頼らない
- D1 は対話的なトランザクションが使えない。複数の書き込みはまとめて実行する（batch）
- 記事の本文やフィードの中身は、信頼できないデータとして扱う。HTML はサニタイズし、LLM や MCP に渡すときも指示として解釈させない

## 変更の進め方

- すべての変更は下書きの PR で出す。`main` へは直接 push できない
- 下書きの PR には Codex のレビューを回し、終了の条件を満たすまで直す。Claude Code では `/review-loop` スキルがこれを回す
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
2. **緩衝層の破れ**：`src/index.ts` と `src/platform/cloudflare/` 以外で、Cloudflare のバインディング、`cloudflare:*`、`node:*` を使っていないか
3. **セキュリティ**
   - 外部 URL の取得で SSRF が起きないか（プライベート IP、リダイレクト先、URL スキームの制限）
   - 記事本文の HTML がサニタイズされているか。LLM や MCP への入力で、本文がプロンプトインジェクションの経路になっていないか
   - 認証のないエンドポイント、MCP の書き込み権限の過不足
   - API キーやトークンがログやレスポンスに出ていないか
4. **データの壊れ**：D1 で途中まで書いて失敗したときに、データが不整合にならないか
5. **テスト**：振る舞いを変える変更に、それを確かめるテストがあるか
6. **PR の書き方**：タイトルがコミットメッセージの形式か。説明に「なぜ」が書かれているか
