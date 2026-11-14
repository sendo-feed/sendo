import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { listFeedsWithFolder } from "../db/feeds";
import { IMPORT_CHUNK_SIZE } from "../jobs/job";
import { readLimited, TooLargeError } from "../lib/read-limited";
import { OpmlError, readOpml, writeOpml } from "../opml";
import type { Platform } from "../platform";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

/** 受け付ける OPML の大きさの上限。数千件のフィードでも十分に収まる */
const MAX_OPML_BYTES = 2 * 1024 * 1024;
/** 応答に載せる「飛ばした URL」の数の上限 */
const MAX_REPORTED_SKIPS = 100;

const ImportResultSchema = z
  .object({
    accepted: z.int().nonnegative().openapi({ description: "登録をキューに積んだフィードの数" }),
    skippedCount: z.int().nonnegative(),
    skipped: z
      .array(
        z.object({
          url: z.string(),
          reason: z.enum(["url_not_allowed", "duplicate", "too_many"]),
        }),
      )
      .openapi({ description: `飛ばしたフィード（最初の ${MAX_REPORTED_SKIPS} 件まで）` }),
  })
  .openapi("OpmlImportResult");

const importRoute = createRoute({
  method: "post",
  path: "/opml",
  summary: "OPML から購読をインポートする",
  description: [
    "Feedly などから書き出した OPML を本文にそのまま送る。フォルダ（カテゴリ）も取り込む。",
    "登録はキューで行うので、応答の時点ではまだ一覧に出ていないことがある。",
    "すでに購読しているフィードは、フォルダに入っていなければ OPML のフォルダに入れる（入っていれば変えない）。何度送っても同じ結果になる。",
  ].join("\n"),
  request: {
    body: {
      required: true,
      content: {
        "application/xml": { schema: z.string() },
        "text/x-opml": { schema: z.string() },
      },
    },
  },
  responses: {
    202: {
      description: "登録をキューに積んだ",
      content: { "application/json": { schema: ImportResultSchema } },
    },
    400: {
      description: "OPML として読めない",
      content: { "application/json": { schema: ErrorSchema } },
    },
    413: {
      description: "大きすぎる",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const exportRoute = createRoute({
  method: "get",
  path: "/opml",
  summary: "購読を OPML で書き出す",
  responses: {
    200: {
      description: "OPML 2.0。フォルダは入れ子の outline になる",
      content: { "text/x-opml": { schema: z.string() } },
    },
  },
});

export function opmlApi(platform: Platform) {
  return new OpenAPIHono({ defaultHook })
    .openapi(importRoute, async (c) => {
      let xml: string;
      try {
        const bytes = await readLimited(
          c.req.raw.body,
          c.req.header("content-length") ?? null,
          MAX_OPML_BYTES,
        );
        xml = new TextDecoder().decode(bytes);
      } catch (error) {
        if (error instanceof TooLargeError) {
          return c.json(errorBody("too_large", error.message), 413);
        }
        throw error;
      }

      let result: ReturnType<typeof readOpml>;
      try {
        result = readOpml(xml);
      } catch (error) {
        if (error instanceof OpmlError)
          return c.json(errorBody("invalid_opml", error.message), 400);
        throw error;
      }

      // D1 のクエリの回数の上限に当たらないように、登録は小分けにしてキューで行う
      const jobs = [];
      for (let i = 0; i < result.entries.length; i += IMPORT_CHUNK_SIZE) {
        jobs.push({
          type: "import-feeds" as const,
          feeds: result.entries.slice(i, i + IMPORT_CHUNK_SIZE),
        });
      }
      await platform.jobs.enqueue(jobs);

      return c.json(
        {
          accepted: result.entries.length,
          skippedCount: result.skipped.length,
          skipped: result.skipped.slice(0, MAX_REPORTED_SKIPS),
        },
        202,
      );
    })
    .openapi(exportRoute, async (c) => {
      const feeds = await listFeedsWithFolder(platform.db);
      const xml = writeOpml(feeds, platform.now());
      return c.body(xml, 200, {
        "content-type": "text/x-opml; charset=utf-8",
        "content-disposition": 'attachment; filename="sendo-subscriptions.opml"',
      });
    });
}
