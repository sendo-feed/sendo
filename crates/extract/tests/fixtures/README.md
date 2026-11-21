# 全文抽出の fixture

骨組みの fixture は、実ページの HTML から [`scripts/skeletonize-page.ts`](../../../../scripts/skeletonize-page.ts) で機械的に生成する。元 HTML はリポジトリの外に置く。作り直すときはスクリプトを通し、生成した HTML は手で編集しない。

fixture は、不具合が起きる構造の例として使う。抽出の規則は `article`、見出し、埋め込みサービスの定型マークアップなど、どのサイトでも通じる HTML の意味に基づき、1〜2 文で説明できる形にする。特定の fixture の `class` 名、入れ子の深さ、要素の並び順に合わせない。その fixture を通すためだけの分岐が必要なら、規則を見直すか、その fixture を対象外にする。

`class` と `id` は、抽出器が関連記事やサイドバーなどの一般的な語を手掛かりにするために残してある。掲載元に固有の名前を抽出条件に使わない。

抽出を変更したら、`cargo test -p sendo-extract --locked` ですべての fixture の結果を確かめる。一つの fixture を通すためだけに、ほかの fixture の結果を変えない。
