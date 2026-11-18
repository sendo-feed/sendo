import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  listSavedPages,
  normalizeSavedUrl,
  removeSavedPage,
  SAVED_PAGE_LIMITS,
  type SavedPage,
  savePage,
} from "../db/saved";
import { base64UrlDecode, base64UrlEncode } from "../lib/crypto";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

export const SavedPageIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const SavedPageSchema = z
  .object({
    id: SavedPageIdSchema,
    url: z.string(),
    title: z.string().nullable(),
    savedAt: z.iso.datetime(),
  })
  .openapi("SavedPage");

export function toSavedPageResponse(page: SavedPage) {
  return { ...page, savedAt: page.savedAt.toISOString() };
}

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});
const saveRoute = createRoute({
  method: "put",
  path: "/saved",
  summary: "ページをあとで読むために保存する",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().trim().min(1).max(SAVED_PAGE_LIMITS.url),
            title: z.string().trim().max(SAVED_PAGE_LIMITS.title).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "保存したページ",
      content: { "application/json": { schema: z.object({ page: SavedPageSchema }) } },
    },
    400: error("URL が正しくない"),
    409: error("保存できる数の上限に達している"),
  },
});
const listRoute = createRoute({
  method: "get",
  path: "/saved",
  summary: "あとで読むページの一覧（保存した日時の新しい順）",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().max(512).optional(),
    }),
  },
  responses: {
    200: {
      description: "保存したページ。続きがあれば nextCursor を返す",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(SavedPageSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    400: error("カーソルが正しくない"),
  },
});
const removeRoute = createRoute({
  method: "delete",
  path: "/saved/{id}",
  summary: "ページの保存を解除する",
  request: {
    params: z.object({ id: SavedPageIdSchema.openapi({ param: { name: "id", in: "path" } }) }),
  },
  responses: { 204: { description: "保存を解除した" } },
});

const CursorSchema = z.object({ at: z.int(), id: SavedPageIdSchema });

function decodeCursor(cursor: string): z.infer<typeof CursorSchema> | null {
  const bytes = base64UrlDecode(cursor);
  if (!bytes) return null;
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function savedApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(saveRoute, async (c) => {
      const { url: raw, title } = c.req.valid("json");
      const url = normalizeSavedUrl(raw);
      if (!url) return c.json(errorBody("invalid_request", "URL must be HTTP or HTTPS"), 400);
      const page = await savePage(db, {
        userId: c.get("user").id,
        url,
        title: title || null,
        now: platform.now(),
      });
      if (!page) return c.json(errorBody("saved_limit_reached", "Saved pages limit reached"), 409);
      return c.json({ page: toSavedPageResponse(page) }, 200);
    })
    .openapi(listRoute, async (c) => {
      const query = c.req.valid("query");
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (cursor === null) return c.json(errorBody("invalid_request", "cursor is invalid"), 400);
      const { items, next } = await listSavedPages(db, {
        userId: c.get("user").id,
        limit: query.limit,
        cursor,
      });
      return c.json(
        {
          items: items.map(toSavedPageResponse),
          nextCursor: next ? base64UrlEncode(new TextEncoder().encode(JSON.stringify(next))) : null,
        },
        200,
      );
    })
    .openapi(removeRoute, async (c) => {
      await removeSavedPage(db, {
        userId: c.get("user").id,
        id: c.req.valid("param").id,
        now: platform.now(),
      });
      return c.body(null, 204);
    });
}
