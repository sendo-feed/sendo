import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createTag,
  listTags,
  MAX_TAG_DESCRIPTION_LENGTH,
  MAX_TAG_NAME_LENGTH,
  MAX_TAGS,
  parseTagInput,
  removeTag,
  updateTag,
} from "../db/tags";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody, TagSchema, toTagResponse } from "./schemas";

/*
 * タグの REST API（docs/decisions/tags.md の 4、6）。形はベル（api/bells.ts）にそろえる。
 */

const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "id", in: "path" } }),
});

const nameField = z.string().openapi({
  description: `名前。前後の空白を除いて 1〜${MAX_TAG_NAME_LENGTH} 文字（コードポイント）。制御文字は含められない`,
});
const descriptionField = z.string().openapi({
  description: `説明。前後の空白を除いて 0〜${MAX_TAG_DESCRIPTION_LENGTH} 文字（コードポイント）。Go のように短く紛らわしい名前の意味を決めるのに使う`,
});

// 知らない項目は黙って捨てず、400 で断る（ベルと同じ）
const CreateBodySchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .optional()
      .openapi({ description: "クライアントが決めた小文字の UUID。省略時は Sendo が決める" }),
    name: nameField,
    description: descriptionField.optional(),
  })
  .openapi("CreateTagRequest");

const UpdateBodySchema = z
  .strictObject({ name: nameField, description: descriptionField.optional() })
  .openapi("UpdateTagRequest");

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const tagResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: z.object({ tag: TagSchema }) } },
});

const listRoute = createRoute({
  method: "get",
  path: "/tags",
  summary: "有効なタグを作った順で返す",
  responses: {
    200: {
      description: "有効なタグの一覧と、自動のタグ付けの判定し直しの残りの記事の数",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(TagSchema),
            rejudgeRemaining: z.int().nonnegative().openapi({
              description:
                "自動のタグ付けが判定し直す残りの記事の数（docs/decisions/auto-tagging.md の 6）",
            }),
          }),
        },
      },
    },
  },
});

const createTagRoute = createRoute({
  method: "post",
  path: "/tags",
  summary: "タグを作る",
  description: `候補から選ぶときも、名前を打つときも同じ。有効なタグは ${MAX_TAGS} 個まで。クライアントは応答の id を正とする。`,
  request: {
    body: { required: true, content: { "application/json": { schema: CreateBodySchema } } },
  },
  responses: {
    200: tagResponse(
      "同じ照合用の名前の有効なタグがある。送った id・説明・上限によらず、そのタグを返す",
    ),
    201: tagResponse("作った"),
    400: error("名前か説明が決まりに合わない"),
    409: error(
      `有効なタグが ${MAX_TAGS} 個ある（tag_limit_reached）か、指定した id はほかの行に使われている（tag_id_taken）`,
    ),
  },
});

const updateTagRoute = createRoute({
  method: "patch",
  path: "/tags/{id}",
  summary: "タグの名前と説明を変える",
  request: {
    params: IdParamSchema,
    body: { required: true, content: { "application/json": { schema: UpdateBodySchema } } },
  },
  responses: {
    200: tagResponse("変えた"),
    400: error("名前か説明が決まりに合わない"),
    404: error("本人の有効なタグがない"),
    409: error("変えた照合用の名前が、ほかの有効なタグと同じ（tag_name_taken）"),
  },
});

const removeTagRoute = createRoute({
  method: "delete",
  path: "/tags/{id}",
  summary: "タグを消す",
  request: { params: IdParamSchema },
  responses: {
    204: { description: "消した、または消してあった" },
    404: error("本人のタグがない"),
  },
});

export function tagsApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(listRoute, async (c) => {
      const items = await listTags(db, c.get("user").id);
      // 自動のタグ付けを入れるまでは、判定し直す記事はない
      return c.json({ items: items.map(toTagResponse), rejudgeRemaining: 0 }, 200);
    })
    .openapi(createTagRoute, async (c) => {
      const { id = crypto.randomUUID(), ...body } = c.req.valid("json");
      const input = parseTagInput(body);
      if (typeof input === "string") return c.json(errorBody("invalid_request", input), 400);
      const result = await createTag(db, { userId: c.get("user").id, id, ...input });
      if (result === "tag_limit_reached") {
        return c.json(errorBody("tag_limit_reached", "tag limit reached"), 409);
      }
      if (result === "tag_id_taken") {
        return c.json(errorBody("tag_id_taken", "tag id is unavailable"), 409);
      }
      return c.json({ tag: toTagResponse(result.tag) }, result.created ? 201 : 200);
    })
    .openapi(updateTagRoute, async (c) => {
      const input = parseTagInput(c.req.valid("json"));
      if (typeof input === "string") return c.json(errorBody("invalid_request", input), 400);
      const result = await updateTag(db, {
        userId: c.get("user").id,
        id: c.req.valid("param").id,
        ...input,
      });
      if (result === "not_found") return c.json(errorBody("not_found", "tag does not exist"), 404);
      if (result === "tag_name_taken") {
        return c.json(errorBody("tag_name_taken", "another tag has the same name"), 409);
      }
      return c.json({ tag: toTagResponse(result.tag) }, 200);
    })
    .openapi(removeTagRoute, async (c) => {
      const removed = await removeTag(db, {
        userId: c.get("user").id,
        id: c.req.valid("param").id,
        now: platform.now(),
      });
      if (removed === "not_found") return c.json(errorBody("not_found", "tag does not exist"), 404);
      return c.body(null, 204);
    });
}
