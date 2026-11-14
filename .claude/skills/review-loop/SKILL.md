---
name: review-loop
description: 下書きの PR に Codex のレビューを回し、指摘を判定して直し、終了の条件を満たすまで繰り返す。PR を出すとき、または「レビューを回して」と言われたときに使う。
---

# Codex レビューのループ

規約の全文は CONTRIBUTING.md の「レビューの進め方」（https://github.com/sendo-feed/.github/blob/main/CONTRIBUTING.md ）。この手順はそれを回すためのもの。

## 終了の条件

| ラウンド | 終了の条件 | 満たさないとき |
|---|---|---|
| 1〜4 回目 | 指摘がゼロ | 直して次のラウンドへ |
| 5 回目 | P0・P1 がゼロで、有効な P2 もゼロ（残りは P3 か、却下した指摘だけ） | 有効な指摘は直したうえで、下書きのまま止めて2人に報告する |

## 手順

### 0. 準備

- 変更はコミット済みで、作業ブランチにいること。`main` にいたら、`<type>/<短い名前>` のブランチを切る。
- `docs/decisions/` の変更とほかの変更が混ざっていたら、PR を分ける（スカッシュマージで1コミットになるため）。

### 1. 下書きの PR を用意する

```sh
gh pr view --json number,isDraft,url   # すでにあればそれを使う
```

なければ push して作る。タイトルはコミットメッセージの形式、本文は PR テンプレートの「何を変えたか」「なぜ変えたか」「確認したこと」を埋める。

```sh
git push -u origin HEAD
gh pr create --draft --title "<type>(<scope>): <件名>" --body-file <本文のファイル>
```

### 2. ラウンドを始める

- 今のラウンド数は「この PR に付いている `@codex review` のコメントの数 ＋ 1」。状態はファイルに持たず、毎回 GitHub から数える。

```sh
gh api "repos/{owner}/{repo}/issues/<番号>/comments" --paginate \
  --jq '[.[] | select(.body | test("^@codex review"))] | length'
```

- 6 回目になる場合は始めない（5 回目で必ず止まっているはず）。
- レビューを依頼する：`gh pr comment <番号> --body "@codex review"`

### 3. Codex のレビューを待つ

- 依頼コメントより後に、Codex のアカウント（ログイン名に `codex` を含む）からのレビューかコメントが付くまで待つ。
- 待つときはバックグラウンドで 60 秒おきに確かめ、30 分たっても来なければ止めて報告する。

```sh
# レビュー本体
gh api "repos/{owner}/{repo}/pulls/<番号>/reviews" --paginate \
  --jq '[.[] | select(.user.login | test("codex")) | {id, submitted_at, body}]'
# 行ごとの指摘
gh api "repos/{owner}/{repo}/pulls/<番号>/comments" --paginate \
  --jq '[.[] | select(.user.login | test("codex")) | {id, path, line, created_at, body}]'
# 「問題なし」の返事はここに来ることがある
gh api "repos/{owner}/{repo}/issues/<番号>/comments" --paginate \
  --jq '[.[] | select(.user.login | test("codex")) | {id, created_at, body}]'
```

- 今回のラウンドの指摘は、依頼コメントより後に付いたものだけ。

### 4. 指摘を判定する

指摘ごとに、優先度と有効かどうかを決める。

- **優先度**：本文の P0〜P3 の表示に従う。表示がなければ AGENTS.md の定義で自分で付ける。
- **有効かどうか**：Codex の指摘をそのまま信じない。コードと `docs/decisions/` を読んで確かめる。判断に迷う P0・P1 は有効として扱う。
- **有効なもの**：直してコミットし（Conventional Commits）、push する。
- **却下するもの**：その指摘に理由を返信する。

```sh
gh api -X POST "repos/{owner}/{repo}/pulls/<番号>/comments/<コメントID>/replies" -f body="<却下の理由>"
```

- 指摘に応えるために `docs/decisions/` の決定を変える必要が出たら、直さずにそこで止め、2人に相談する。

### 5. 終了を判定する

上の表で判定する。

- **続ける**：手順 2 に戻る。
- **終了**：PR にまとめのコメント（ラウンド数、直した指摘、却下した指摘とその理由）を書き、`gh pr ready <番号>` で下書きを外して、2人に報告する。**マージはしない。**
- **5 回目で打ち切り**：まとめのコメントを書き、下書きのまま止めて、残った指摘と一緒に2人に報告する。
