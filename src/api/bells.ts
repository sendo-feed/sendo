import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { addBell, listBells, MAX_BELLS, removeBell } from "../db/bells";
import {
  BELL_WORDS_PROBLEMS,
  MAX_BELL_WORDS,
  MAX_BELL_WORDS_LENGTH,
  parseBellTarget,
} from "../notify/words";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { BellSchema, ErrorSchema, errorBody, toBellResponse } from "./schemas";

/*
 * 通知のベルの REST API（docs/decisions/notifications.md の 5〜7）。
 */

const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "id", in: "path" } }),
});

// 知らない項目は黙って捨てず、400 で断る。捨てると、頼んだのと違うベルができる。feedId と words の
// 少なくとも一方が要ることと、言葉の数と長さは、ハンドラーで確かめる（notify/words.ts）
const AddBodySchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .optional()
      .openapi({ description: "クライアントが決めた小文字の UUID。省略時は Sendo が決める" }),
    feedId: z.string().min(1).max(64).optional().openapi({
      description:
        "鳴らす購読のフィードの ID。言葉だけのベルは省く。feedId と words の少なくとも一方が要る",
    }),
    words: z
      .string()
      .optional()
      .openapi({
        description: `当てる言葉。空白で区切った言葉をすべて含む記事に当てる（AND）。NFKC にしてから区切り、重なりを除いた形で 1〜${MAX_BELL_WORDS} 個、全体で ${MAX_BELL_WORDS_LENGTH} 文字まで。購読だけのベルは省く`,
      }),
  })
  .openapi("AddBellRequest");

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const bellResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: z.object({ bell: BellSchema }) } },
});

const listRoute = createRoute({
  method: "get",
  path: "/bells",
  summary: "有効なベルを作った順で返す",
  responses: {
    200: {
      description: "有効なベルの一覧",
      content: { "application/json": { schema: z.object({ items: z.array(BellSchema) }) } },
    },
  },
});

const addRoute = createRoute({
  method: "post",
  path: "/bells",
  summary: "ベルを付ける",
  description: `購読だけ、言葉だけ、購読 AND 言葉のベルを付ける。有効なベルは ${MAX_BELLS} 個まで。クライアントは応答の id を正とする。`,
  request: {
    body: { required: true, content: { "application/json": { schema: AddBodySchema } } },
  },
  responses: {
    200: bellResponse(
      "同じ組（購読と言葉）の有効なベルがある。送った id と言葉の並びによらず、そのベルを返す",
    ),
    201: bellResponse("付けた"),
    400: error("入力が正しくない。feedId も words もないか、言葉が上限などに合わない"),
    404: error("feedId のフィードの有効な購読がない"),
    409: error(
      `有効なベルが ${MAX_BELLS} 個ある（bell_limit_reached）か、指定した id はほかのベルに使われている（bell_id_taken）`,
    ),
  },
});

const removeRoute = createRoute({
  method: "delete",
  path: "/bells/{id}",
  summary: "ベルを外す",
  request: { params: IdParamSchema },
  responses: {
    204: { description: "外した、または外してあった" },
    404: error("ベルがない"),
  },
});

export function bellsApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(listRoute, async (c) => {
      const items = await listBells(db, c.get("user").id);
      return c.json({ items: items.map(toBellResponse) }, 200);
    })
    .openapi(addRoute, async (c) => {
      const { id = crypto.randomUUID(), ...input } = c.req.valid("json");
      const target = parseBellTarget(input);
      if (target === "missing") {
        return c.json(errorBody("invalid_request", "feedId or words is required"), 400);
      }
      if (typeof target === "string") {
        return c.json(errorBody("invalid_request", BELL_WORDS_PROBLEMS[target]), 400);
      }
      const result = await addBell(db, { userId: c.get("user").id, id, ...target });
      if (result === "feed_not_found") {
        return c.json(errorBody("not_found", "feed is not subscribed"), 404);
      }
      if (result === "bell_limit_reached") {
        return c.json(errorBody("bell_limit_reached", "bell limit reached"), 409);
      }
      if (result === "bell_id_taken") {
        return c.json(errorBody("bell_id_taken", "bell id is unavailable"), 409);
      }
      return c.json({ bell: toBellResponse(result.bell) }, result.created ? 201 : 200);
    })
    .openapi(removeRoute, async (c) => {
      const removed = await removeBell(db, {
        userId: c.get("user").id,
        id: c.req.valid("param").id,
        now: platform.now(),
      });
      if (removed === "not_found")
        return c.json(errorBody("not_found", "bell does not exist"), 404);
      return c.body(null, 204);
    });
}
