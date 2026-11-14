-- drizzle-kit が扱わない SQL を、手で書いている（drizzle-kit generate --custom で作った枠）。

-- すでにある記事に、Google Reader API のアイテムの ID（1 以上 2^53 未満の乱数）を振る
-- （docs/decisions/greader.md の 3）。random() は 64 ビットの整数を返すので、下の 53 ビットだけを
-- 取る（abs() は最小の値で溢れるので使わない）。0 になったものは 1 にする。
-- 次のマイグレーションで一意の索引を作る。そのあとに取り込む記事には、insertArticles が振る。
UPDATE `articles` SET `item_id` = max(1, random() & 9007199254740991) WHERE `item_id` = 0;
