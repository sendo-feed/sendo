import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createFolder,
  deleteFolder,
  FolderNameTakenError,
  listFolders,
  MAX_FOLDER_NAME_LENGTH,
  normalizeFolderName,
  renameFolder,
} from "../db/folders";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody, FolderSchema, toFolderResponse } from "./schemas";

const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "id", in: "path" } }),
});

const FolderBodySchema = z
  .object({
    name: z
      .string()
      .max(MAX_FOLDER_NAME_LENGTH * 2)
      .openapi({ description: `前後の空白を除き、${MAX_FOLDER_NAME_LENGTH} 文字までに切り詰める` }),
  })
  .openapi("FolderRequest");

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const folderResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: z.object({ folder: FolderSchema }) } },
});

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

const createFolderRoute = createRoute({
  method: "post",
  path: "/folders",
  summary: "フォルダを作る",
  request: {
    body: { required: true, content: { "application/json": { schema: FolderBodySchema } } },
  },
  responses: {
    201: folderResponse("作った"),
    400: error("名前が空"),
    409: error("同じ名前のフォルダがある"),
  },
});

const renameRoute = createRoute({
  method: "patch",
  path: "/folders/{id}",
  summary: "フォルダの名前を変える",
  request: {
    params: IdParamSchema,
    body: { required: true, content: { "application/json": { schema: FolderBodySchema } } },
  },
  responses: {
    200: folderResponse("変えた"),
    400: error("名前が空"),
    404: error("フォルダがない"),
    409: error("同じ名前のフォルダがある"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/folders/{id}",
  summary: "フォルダを消す",
  description: "入っていたフィードは消さず、フォルダなしに戻す。",
  request: { params: IdParamSchema },
  responses: {
    204: { description: "消した" },
    404: error("フォルダがない"),
  },
});

export function foldersApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(listRoute, async (c) => {
      const folders = await listFolders(db, c.get("user").id);
      return c.json({ items: folders.map(toFolderResponse) }, 200);
    })
    .openapi(createFolderRoute, async (c) => {
      const name = normalizeFolderName(c.req.valid("json").name);
      if (name === null) return c.json(errorBody("invalid_request", "name: empty"), 400);
      try {
        const folder = await createFolder(db, {
          userId: c.get("user").id,
          id: crypto.randomUUID(),
          name,
          now: platform.now(),
        });
        return c.json({ folder: toFolderResponse(folder) }, 201);
      } catch (e) {
        if (e instanceof FolderNameTakenError) {
          return c.json(errorBody("folder_exists", "a folder with this name exists"), 409);
        }
        throw e;
      }
    })
    .openapi(renameRoute, async (c) => {
      const { id } = c.req.valid("param");
      const name = normalizeFolderName(c.req.valid("json").name);
      if (name === null) return c.json(errorBody("invalid_request", "name: empty"), 400);
      try {
        const folder = await renameFolder(db, { userId: c.get("user").id, id, name });
        if (!folder) return c.json(errorBody("not_found", "folder does not exist"), 404);
        return c.json({ folder: toFolderResponse(folder) }, 200);
      } catch (e) {
        if (e instanceof FolderNameTakenError) {
          return c.json(errorBody("folder_exists", "a folder with this name exists"), 409);
        }
        throw e;
      }
    })
    .openapi(deleteRoute, async (c) => {
      const { id } = c.req.valid("param");
      if (!(await deleteFolder(db, { userId: c.get("user").id, id, now: platform.now() }))) {
        return c.json(errorBody("not_found", "folder does not exist"), 404);
      }
      return c.body(null, 204);
    });
}
