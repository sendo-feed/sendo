# sendo

Sendo のサーバー本体。REST API、Google Reader API 互換、MCP、フィードの取得ジョブを持つ。

## 最初に読むもの

- `docs/decisions/`：今の決定。ほかの文書と食い違ったら、こちらが正しい
- `docs/inception-deck.md`：プロダクトの目的と進め方
- `docs/tech-deck.md`：技術構成の全体像

## 言語

- 文書、コミットメッセージ、PR は日本語で書く（一般に公開したら英語に切り替える）
- 識別子は英語

## コミットメッセージ

Conventional Commits を土台にする。全文は https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md

- 形式：`<type>(<scope>): <件名>`。type は feat ／ fix ／ docs ／ decision ／ refactor ／ perf ／ test ／ build ／ ci ／ chore ／ revert
- 本文には「なぜ」を書く
- `docs/decisions/` を変えるときは `decision(<テーマ>): …` にし、本文に何をなぜ変えたかを書く。コードの変更とは分けて単独のコミットにする
- `main` に force push しない

## 決定の扱い

- 決定は `docs/decisions/<テーマ>.md` にテーマごとに置き、今の決定だけを書く。決定が変わったらファイルを書き換え、古い内容は残さない
- 経緯を聞かれたら `git log -p -- docs/decisions/<テーマ>.md` を読んで答える
- 決定ファイルを足したり状態を変えたりしたら、`docs/decisions/README.md` の一覧も直す
