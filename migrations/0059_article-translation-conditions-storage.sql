-- 訳したときの条件（docs/decisions/translation.md の 18）を足した。
--
-- 1. この決まりより前に訳した行（translated_at のある行）は、思考量を low にする（前の決まりではいつも low
--    で送っていた）。段階、プロンプトの版、トークン数、呼び出しのモデル、写した元は null のまま。
--    差分同期の更新のトリガー（0057）は、足した列だけが変わっても番号を振らない（配るのは別の変更）。
-- 2. 足した列のうち、訳文と一緒に書く文字の列（思考量、段階、呼び出しのモデル、写した元の記事の ID）も、
--    訳したモデル（model）と同じく文字のバイト数で記事の保管容量に含める（retention.md の 2、
--    translation.md の 12、18）。数の列（プロンプトの版、トークン数）と、バッチで送った条件（送る印と
--    一緒に外す）は、ほかのバッチの列と同じく 1 行の見積もり（512 バイト）の中に含める。0048 のトリガーを、
--    これらの列も数える形に置き換え、1 で書いた思考量の分を使用量に足す。
--
-- drizzle-kit はトリガーとデータの書き換えを扱わないので、手で書いている（drizzle-kit generate --custom で
-- 作った枠）。容量を超える行と訳文は書かない（0048 と同じ）。
UPDATE article_translations SET effort = 'low' WHERE translated_at IS NOT NULL AND effort IS NULL;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_admission;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_insert;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_delete;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_update_admission;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_update;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_admission BEFORE INSERT ON article_translations
WHEN NOT EXISTS (SELECT 1 FROM article_translations WHERE article_id = NEW.article_id)
  AND (SELECT bytes + (512 + (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0) + coalesce(length(cast(NEW.effort as blob)), 0) + coalesce(length(cast(NEW.tier as blob)), 0) + coalesce(length(cast(NEW.call_model as blob)), 0) + coalesce(length(cast(NEW.title_copied_from as blob)), 0) + coalesce(length(cast(NEW.summary_copied_from as blob)), 0) + coalesce(length(cast(NEW.content_copied_from as blob)), 0))) > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_insert AFTER INSERT ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes + (512 + (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0) + coalesce(length(cast(NEW.effort as blob)), 0) + coalesce(length(cast(NEW.tier as blob)), 0) + coalesce(length(cast(NEW.call_model as blob)), 0) + coalesce(length(cast(NEW.title_copied_from as blob)), 0) + coalesce(length(cast(NEW.summary_copied_from as blob)), 0) + coalesce(length(cast(NEW.content_copied_from as blob)), 0))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_delete AFTER DELETE ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes - (512 + (coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0) + coalesce(length(cast(OLD.content as blob)), 0) + coalesce(length(cast(OLD.effort as blob)), 0) + coalesce(length(cast(OLD.tier as blob)), 0) + coalesce(length(cast(OLD.call_model as blob)), 0) + coalesce(length(cast(OLD.title_copied_from as blob)), 0) + coalesce(length(cast(OLD.summary_copied_from as blob)), 0) + coalesce(length(cast(OLD.content_copied_from as blob)), 0))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_update_admission BEFORE UPDATE OF title, summary, model, content, effort, tier, call_model, title_copied_from, summary_copied_from, content_copied_from ON article_translations
WHEN (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0) + coalesce(length(cast(NEW.effort as blob)), 0) + coalesce(length(cast(NEW.tier as blob)), 0) + coalesce(length(cast(NEW.call_model as blob)), 0) + coalesce(length(cast(NEW.title_copied_from as blob)), 0) + coalesce(length(cast(NEW.summary_copied_from as blob)), 0) + coalesce(length(cast(NEW.content_copied_from as blob)), 0)) > (coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0) + coalesce(length(cast(OLD.content as blob)), 0) + coalesce(length(cast(OLD.effort as blob)), 0) + coalesce(length(cast(OLD.tier as blob)), 0) + coalesce(length(cast(OLD.call_model as blob)), 0) + coalesce(length(cast(OLD.title_copied_from as blob)), 0) + coalesce(length(cast(OLD.summary_copied_from as blob)), 0) + coalesce(length(cast(OLD.content_copied_from as blob)), 0))
  AND (SELECT bytes + (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0) + coalesce(length(cast(NEW.effort as blob)), 0) + coalesce(length(cast(NEW.tier as blob)), 0) + coalesce(length(cast(NEW.call_model as blob)), 0) + coalesce(length(cast(NEW.title_copied_from as blob)), 0) + coalesce(length(cast(NEW.summary_copied_from as blob)), 0) + coalesce(length(cast(NEW.content_copied_from as blob)), 0)) - (coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0) + coalesce(length(cast(OLD.content as blob)), 0) + coalesce(length(cast(OLD.effort as blob)), 0) + coalesce(length(cast(OLD.tier as blob)), 0) + coalesce(length(cast(OLD.call_model as blob)), 0) + coalesce(length(cast(OLD.title_copied_from as blob)), 0) + coalesce(length(cast(OLD.summary_copied_from as blob)), 0) + coalesce(length(cast(OLD.content_copied_from as blob)), 0)) > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_update AFTER UPDATE OF title, summary, model, content, effort, tier, call_model, title_copied_from, summary_copied_from, content_copied_from ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes + (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0) + coalesce(length(cast(NEW.effort as blob)), 0) + coalesce(length(cast(NEW.tier as blob)), 0) + coalesce(length(cast(NEW.call_model as blob)), 0) + coalesce(length(cast(NEW.title_copied_from as blob)), 0) + coalesce(length(cast(NEW.summary_copied_from as blob)), 0) + coalesce(length(cast(NEW.content_copied_from as blob)), 0)) - (coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0) + coalesce(length(cast(OLD.content as blob)), 0) + coalesce(length(cast(OLD.effort as blob)), 0) + coalesce(length(cast(OLD.tier as blob)), 0) + coalesce(length(cast(OLD.call_model as blob)), 0) + coalesce(length(cast(OLD.title_copied_from as blob)), 0) + coalesce(length(cast(OLD.summary_copied_from as blob)), 0) + coalesce(length(cast(OLD.content_copied_from as blob)), 0)) WHERE id = 1;
END;
--> statement-breakpoint
UPDATE storage_usage SET bytes = bytes + (
  SELECT coalesce(sum(length(cast(effort as blob))), 0) FROM article_translations
) WHERE id = 1;
