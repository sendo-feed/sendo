-- drizzle-kit が扱わない SQL を、手で書いている（drizzle-kit generate --custom で作った枠）。

-- Discord のフィードの icon_checked_at を空にする（docs/decisions/discord.md の 7）。
-- icon_checked_at は、サーバーにアイコンがないときに discord.com を探した時刻で、サーバーのアイコンの
-- 記録では進めない。前の実装は、サーバーのアイコンを記録するたびに付けていたので、そのままだと、
-- サーバーにアイコンがないフィードが 30 日探しにいかない。空にすると、次の取得で探す。
-- アイコン（icon_url）は変えないので、購読の変更番号は進まない。
UPDATE `feeds` SET `icon_checked_at` = NULL WHERE `discord_cursor` IS NOT NULL;
