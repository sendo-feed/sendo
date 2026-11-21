# 全文抽出の fixture

骨組みの fixture は、実ページの HTML から [`scripts/skeletonize-page.ts`](../../../../scripts/skeletonize-page.ts) で機械的に生成する。元 HTML はリポジトリの外に置く。作り直すときはスクリプトを通し、生成した HTML は手で編集しない。

リポジトリのルートから `node --import tsx scripts/skeletonize-page.ts <元HTML> <出力先> <ページURL> [掲載名 ...]` を実行する。掲載名には、ホスト名から分からない表記も渡す。

`lead-embeds-*.html` は、本文より手前の埋め込みが抽出範囲から外れる例。 `candidate-*.html` は、ほかのページから元 HTML と骨組みで本文のタグの並び、文字数、埋め込みの数が一致した例を選んだもの。本文に埋め込みが残る例も含む。

fixture は、不具合が起きる構造の例として使う。抽出の規則は `article`、見出し、埋め込みサービスの定型マークアップなど、どのサイトでも通じる HTML の意味に基づき、1〜2 文で説明できる形にする。特定の fixture の `class` 名、入れ子の深さ、要素の並び順に合わせない。その fixture を通すためだけの分岐が必要なら、規則を見直すか、その fixture を対象外にする。

`class` と `id` は、抽出器が関連記事やサイドバーなどの一般的な語を手掛かりにするために残してある。掲載元に固有の名前を抽出条件に使わない。

抽出を変更したら、`cargo test -p sendo-extract --locked` ですべての fixture の結果を確かめる。一つの fixture を通すためだけに、ほかの fixture の結果を変えない。
