# 決定の一覧

Sendo で決めたことを、テーマごとに1ファイルで置く。各ファイルには今の決定だけを書き、経緯は git の履歴で追う。残し方は [documentation.md](documentation.md) を参照。

| テーマ | 状態 | 概要 |
|---|---|---|
| [決定の残し方](documentation.md) | 提案中 | テーマごとに1ファイルを書き換える。履歴は git が持つ |
| [テックスタック](tech-stack.md) | 提案中 | TypeScript ＋ Hono。第1版は Cloudflare 前提で、緩衝層を挟む |
| [ユーザーと認証](accounts.md) | 提案中 | ユーザーの表を持ち、パスワードは持たない。ログインは自前の OpenID Connect（Google）、許可したメールだけ。データは人ごと |

経緯を知りたいとき：

```sh
git log -p -- docs/decisions/<テーマ>.md
```
