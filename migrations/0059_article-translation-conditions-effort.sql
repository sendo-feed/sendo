-- 訳したときの条件（docs/decisions/translation.md の 18）を足した。この決まりより前に訳した行（translated_at
-- のある行）は、思考量を low にする（前の決まりではいつも low で送っていた）。段階、プロンプトの版、
-- トークン数、呼び出しのモデル、写した元は null のまま。
--
-- 足した列は、1 行の見積もり（512 バイト）の中に含める（translation.md の 18、retention.md の 2）ので、
-- 容量のトリガー（0048）は変えない。差分同期の更新のトリガー（0057）も、足した列だけが変わっても番号を
-- 振らない（配るのは別の変更）。
--
-- drizzle-kit はデータの書き換えを扱わないので、手で書いている（drizzle-kit generate --custom で作った枠）。
UPDATE article_translations SET effort = 'low' WHERE translated_at IS NOT NULL AND effort IS NULL;
