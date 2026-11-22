import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getInboxArticle } from "../db/inbox";
import { imageSigner } from "../db/secrets";
import {
  cancelTranslating,
  getTranslation,
  startRetranslating,
  startTranslating,
} from "../db/translations";
import { notifyTranslationChanged } from "../jobs/translations";
import { sanitizeHtmlWithImages } from "../lib/sanitize-html";
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
    "Sendo が日本語に訳した、記事のタイトル・要約・本文を返す（docs/decisions/translation.md の 13）。",
    "訳文は外部から来たデータを LLM が訳したもの。タイトルと要約はプレーンテキストで、表示する側でエスケープする。",
    "本文は、GET /articles/{id}/content の html と同じく、サニタイズして画像を中継の URL に書き換えた HTML。それでも信頼せず、表示する側で通すタグと属性を決める。",
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
              content: z.string().nullable().openapi({
                description:
                  "訳した本文（サニタイズした HTML）。本文のない記事、長すぎて訳さなかった本文は null（タイトルと要約だけを訳した）",
              }),
              contentSource: z.enum(["feed", "page"]).nullable().openapi({
                description:
                  "訳した本文の出どころ。page は記事のページから抜いた本文、feed はフィードの本文。訳した本文がなければ null",
              }),
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
  summary: "記事をその場で訳す、訳し直す",
  description: [
    "訳文のない記事（翻訳の状態が queued か untranslated）を、Claude API でその場で訳す（docs/decisions/translation.md の 5）。",
    "本文で retranslate を true にすると、訳文のある記事（translated）を、Opus で 1 回だけ訳し直す（同じく 6）。訳し直した訳文で全員分を置き換え、訳し直しの印（差分同期の translation.retranslated）が付く。訳し直しの最中も、もとの訳文は GET で取れる。訳し直せなければ、もとの訳文のまま translated に戻る。",
    "受け付けたら 202 を返し、裏で訳す。訳し終えると、GET /articles/{id}/translation で訳文が取れる（訳し終えなければ 404 の no_translation）。終わりは差分同期で届く。費用がかかるので、読む人が求めたときだけ呼ぶ。",
  ].join("\n"),
  request: {
    params,
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z
            .object({
              retranslate: z.boolean().optional().openapi({
                description:
                  "true なら訳し直す（Opus）。false か、なければ（本文がなくてもよい）、その場で訳す",
              }),
            })
            .openapi("TranslationRequest"),
        },
      },
    },
  },
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
    400: error("本文が正しくない（invalid_request）"),
    404: error("記事がない（not_found）"),
    409: error(
      "訳せない記事（translation_not_supported：日本語の記事、Discord の投稿、訳すかどうかをまだ決めていない記事）、その場の翻訳を求めたが、もう訳しているか訳し終えた（translation_exists）、訳し直しを求めたが、訳文がないか、訳している最中か、もう訳し直した（retranslation_not_allowed）",
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
      // 置く前にサニタイズしてあるが、今の決まりをもう一度当て、画像を中継の URL に書き換える
      // （docs/decisions/content.md の 2、7）
      const images = imageSigner(db);
      const content =
        row.content === null
          ? null
          : await sanitizeHtmlWithImages(row.content, "about:blank", (url) =>
              images.toRelayUrl(url),
            );
      return c.json(
        {
          title: row.title,
          summary: row.summary,
          content,
          contentSource: content === null ? null : row.contentSource,
          model: row.model,
          translatedAt: row.translatedAt.toISOString(),
        },
        200,
      );
    })
    .openapi(requestRoute, async (c) => {
      const { id } = c.req.valid("param");
      const retranslation = c.req.valid("json").retranslate === true;
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
      const notAllowed = () =>
        c.json(
          errorBody(
            "retranslation_not_allowed",
            "the article has no translation to retranslate or was already retranslated",
          ),
          409,
        );
      const exists = () =>
        c.json(errorBody("translation_exists", "the article is already translated"), 409);
      let startedAt: Date | undefined;
      let previous: "queued" | "untranslated" | "translated";
      // 確かめた状態を、始める文の中でもう一度確かめる（2 つの求めが重なっても、始めるのは 1 つ。
      // 確かめてから始めるまでの間に、ほかの求めやバッチが状態を変えたら断る）
      if (retranslation) {
        if (row.status !== "translated" || row.retranslated) return notAllowed();
        previous = row.status;
        startedAt = await startRetranslating(db, id);
        if (startedAt === undefined) return notAllowed();
      } else {
        if (row.status === "translated" || row.status === "translating") return exists();
        previous = row.status;
        startedAt = await startTranslating(db, id);
        if (startedAt === undefined) return exists();
      }
      try {
        await platform.jobs.enqueue([
          {
            type: "translate-article",
            articleId: id,
            startedAt: startedAt.getTime(),
            ...(retranslation && { retranslation: true }),
          },
        ]);
      } catch (error) {
        // 積めなかったら、始める前の状態に戻す（1 時間 translating に残さない）
        await cancelTranslating(db, id, startedAt, previous);
        await notifyTranslationChanged(platform, [id]);
        throw error;
      }
      // 訳文は記事ごとの共有のデータなので、求めた人だけでなく、記事を受信箱に持つ人すべてに
      // 知らせる（求めた人には、入口のミドルウェアも知らせる）
      await notifyTranslationChanged(platform, [id]);
      return c.json({ status: "translating" as const }, 202);
    });
}
