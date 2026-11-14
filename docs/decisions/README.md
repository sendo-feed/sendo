# 決定の一覧

Sendo で決めたことを、テーマごとに1ファイルで置く。各ファイルには今の決定だけを書き、経緯は git の履歴で追う。残し方は [documentation.md](documentation.md) を参照。

| テーマ | 状態 | 概要 |
|---|---|---|
| [決定の残し方](documentation.md) | 提案中 | テーマごとに1ファイルを書き換える。履歴は git が持つ |
| [テックスタック](tech-stack.md) | 提案中 | TypeScript ＋ Hono。第1版は Cloudflare 前提で、緩衝層を挟む |
| [ユーザーと認証](accounts.md) | 提案中 | ユーザーの表を持ち、パスワードは持たない。ログインは自前の OpenID Connect（Google など、1 人が複数の提供元を持てる）、許可したメールだけ。データは人ごと |
| [差分同期](sync.md) | 提案中 | 人ごとのデータに書き込み順の変更番号を振り、1 回のリクエストで差分を取る。消したものは印と記録で伝える |
| [Google Reader API 互換](greader.md) | 提案中 | パスワードはアクセストークン。アイテムの ID は記事に持たせる乱数の整数。処理は REST API と同じものに任せる |
| [MCP サーバー](mcp.md) | 提案中 | `/mcp` にセッションなしで置き、Sendo 自身が OAuth 2.1 の認可サーバーになる。スコープは read と write。記事は信頼できないデータとして返す |

経緯を知りたいとき：

```sh
git log -p -- docs/decisions/<テーマ>.md
```
