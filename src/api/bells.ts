import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { addBell, listBells, MAX_BELLS, removeBell } from "../db/bells";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { BellSchema, ErrorSchema, errorBody, toBellResponse } from "./schemas";

/*
 * 通知のベルの REST API（docs/decisions/notifications.md の 5）。今は購読のベルだけを扱う。
 */

const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "id", in: "path" } }),
});

// 知らない項目（言葉など）は黙って捨てず、400 で断る。捨てると、頼んだのと違うベルができる
const AddBodySchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .optional()
      .openapi({ description: "クライアントが決めた小文字の UUID。省略時は Sendo が決める" }),
    feedId: z.string().min(1).max(64).openapi({ description: "ベルを付ける購読のフィードの ID" }),
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
  summary: "購読にベルを付ける",
  description: `有効なベルは ${MAX_BELLS} 個まで。クライアントは応答の id を正とする。`,
  request: {
    body: { required: true, content: { "application/json": { schema: AddBodySchema } } },
  },
  responses: {
    200: bellResponse("同じ購読の有効なベルがある。送った id によらず、そのベルを返す"),
    201: bellResponse("付けた"),
    400: error("入力が正しくない"),
    404: error("そのフィードの有効な購読がない"),
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
      const { id = crypto.randomUUID(), feedId } = c.req.valid("json");
      const result = await addBell(db, { userId: c.get("user").id, id, feedId, words: null });
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
