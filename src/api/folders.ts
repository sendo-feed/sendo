import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { listFolders } from "../db/folders";
import type { Platform } from "../platform";
import { defaultHook } from "./hook";
import { FolderSchema, toFolderResponse } from "./schemas";

const listRoute = createRoute({
  method: "get",
  path: "/folders",
  summary: "フォルダの一覧",
  responses: {
    200: {
      description: "フォルダ（名前の順）",
      content: { "application/json": { schema: z.object({ items: z.array(FolderSchema) }) } },
    },
  },
});

export function foldersApi(platform: Platform) {
  return new OpenAPIHono({ defaultHook }).openapi(listRoute, async (c) => {
    const folders = await listFolders(platform.db);
    return c.json({ items: folders.map(toFolderResponse) }, 200);
  });
}
