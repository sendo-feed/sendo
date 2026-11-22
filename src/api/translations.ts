import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getInboxArticle } from "../db/inbox";
import { cancelTranslating, getTranslation, startTranslating } from "../db/translations";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

const params = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "id", in: "path" } }),
});

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const getRoute = createRoute({
  method: "get",
  path: "/articles/{id}/translation",
  summary: "記事の訳文",
  description: [
    "Sendo が日本語に訳した、記事のタイトルと要約を返す（docs/decisions/translation.md の 13）。",
    "訳文は外部から来たデータを LLM が訳したもので、プレーンテキスト。表示する側でエスケープする。",
    "訳し直すと替わる。translatedAt が変わったら取り直す。",
  ].join("\n"),
  request: { params },
  responses: {
    200: {
      description: "訳文",
      content: {
        "application/json": {
          schema: z
            .object({
              title: z.string().nullable().openapi({ description: "訳したタイトル" }),
              summary: z.string().nullable().openapi({ description: "訳した要約" }),
              model: z.string().openapi({ description: "訳したモデル" }),
              translatedAt: z.iso.datetime().openapi({ description: "訳した時刻" }),
            })
            .openapi("ArticleTranslation"),
        },
      },
    },
    404: error("記事がない（not_found）か、訳文がない（no_translation）"),
  },
});

const requestRoute = createRoute({
  method: "post",
  path: "/articles/{id}/translation",
  summary: "記事をその場で訳す",
  description: [
    "訳文のない記事（翻訳の状態が queued か untranslated）を、Claude API でその場で訳す（docs/decisions/translation.md の 5）。",
    "受け付けたら 202 を返し、裏で訳す。訳し終えると、GET /articles/{id}/translation で訳文が取れる（訳し終えなければ 404 の no_translation）。費用がかかるので、読む人が求めたときだけ呼ぶ。",
  ].join("\n"),
  request: { params },
  responses: {
    202: {
      description: "受け付けた。状態は translating になった",
      content: {
        "application/json": {
          schema: z
            .object({ status: z.literal("translating") })
            .openapi("TranslationRequestAccepted"),
        },
      },
    },
    404: error("記事がない（not_found）"),
    409: error(
      "訳せない記事（translation_not_supported：日本語の記事、Discord の投稿、訳すかどうかをまだ決めていない記事）か、もう訳しているか訳し終えた（translation_exists）",
    ),
    503: error("Sendo で翻訳が使えない（translation_unavailable：API キーがない）"),
  },
});

export function translationsApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(getRoute, async (c) => {
      const { id } = c.req.valid("param");
      const article = await getInboxArticle(db, { userId: c.get("user").id, articleId: id });
      if (!article) return c.json(errorBody("not_found", "article does not exist"), 404);
      const row = await getTranslation(db, id);
      if (!row || row.translatedAt === null || row.model === null) {
        return c.json(errorBody("no_translation", "article has no translation"), 404);
      }
      return c.json(
        {
          title: row.title,
          summary: row.summary,
          model: row.model,
          translatedAt: row.translatedAt.toISOString(),
        },
        200,
      );
    })
    .openapi(requestRoute, async (c) => {
      const { id } = c.req.valid("param");
      const article = await getInboxArticle(db, { userId: c.get("user").id, articleId: id });
      if (!article) return c.json(errorBody("not_found", "article does not exist"), 404);
      if (platform.translator === undefined) {
        return c.json(errorBody("translation_unavailable", "translation is not configured"), 503);
      }
      const row = await getTranslation(db, id);
      if (!row || row.status === "skipped") {
        return c.json(
          errorBody("translation_not_supported", "this article is not translated"),
          409,
        );
      }
      if (row.status === "translated" || row.status === "translating") {
        return c.json(errorBody("translation_exists", "the article is already translated"), 409);
      }
      const startedAt = await startTranslating(db, id);
      if (startedAt === undefined) {
        // 確かめてから始めるまでの間に、ほかの求めやバッチが状態を変えた
        return c.json(errorBody("translation_exists", "the article is already translated"), 409);
      }
      try {
        await platform.jobs.enqueue([
          { type: "translate-article", articleId: id, startedAt: startedAt.getTime() },
        ]);
      } catch (error) {
        // 積めなかったら、始める前の状態に戻す（1 時間 translating に残さない）
        await cancelTranslating(db, id, startedAt, row.status);
        throw error;
      }
      return c.json({ status: "translating" as const }, 202);
    });
}
