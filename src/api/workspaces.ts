import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  MAX_WORKSPACE_NAME_LENGTH,
  renameWorkspace,
  setDefaultWorkspace,
} from "../db/workspaces";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody, toWorkspaceResponse, WorkspaceSchema } from "./schemas";

const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "id", in: "path" } }),
});

const NameSchema = z.string().trim().min(1).max(MAX_WORKSPACE_NAME_LENGTH);
const UpdateBodySchema = z
  .union([z.strictObject({ name: NameSchema }), z.strictObject({ isDefault: z.literal(true) })])
  .openapi("UpdateWorkspaceRequest");
const CreateBodySchema = z
  .object({
    name: NameSchema,
    id: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .optional()
      .openapi({ description: "クライアントが決めた小文字の UUID。省略時は Sendo が決める" }),
  })
  .openapi("CreateWorkspaceRequest");

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const workspaceResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: z.object({ workspace: WorkspaceSchema }) } },
});

const listRoute = createRoute({
  method: "get",
  path: "/workspaces",
  summary: "アカウントのワークスペースを名前順で返す",
  responses: {
    200: {
      description: "有効なワークスペースの一覧",
      content: { "application/json": { schema: z.object({ items: z.array(WorkspaceSchema) }) } },
    },
  },
});

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces",
  summary: "ワークスペースを作る",
  request: {
    body: { required: true, content: { "application/json": { schema: CreateBodySchema } } },
  },
  responses: {
    200: workspaceResponse("同じ ID のワークスペースがある。現在の名前を返す"),
    201: workspaceResponse("作った"),
    400: error("名前か ID が正しくない"),
    409: error(
      "名前が使用済み（workspace_exists）か、指定した ID は使えない（workspace_id_taken）",
    ),
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{id}",
  summary: "ワークスペースを改名するか、デフォルトにする",
  request: {
    params: IdParamSchema,
    body: { required: true, content: { "application/json": { schema: UpdateBodySchema } } },
  },
  responses: {
    200: workspaceResponse("指定された項目を更新した"),
    400: error("入力が正しくない。名前かデフォルトの指定のどちらかが必要"),
    404: error("ワークスペースがない"),
    409: error("名前が使用済み（workspace_exists）"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{id}",
  summary: "デフォルト以外で有効な購読が0件のワークスペースを削除する",
  request: { params: IdParamSchema },
  responses: {
    204: { description: "削除した、または削除済み" },
    404: error("ワークスペースがない"),
    409: error("デフォルト（workspace_is_default）か有効な購読がある（workspace_not_empty）"),
  },
});

export function workspacesApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(listRoute, async (c) => {
      const items = await listWorkspaces(db, c.get("user").id);
      return c.json({ items: items.map(toWorkspaceResponse) }, 200);
    })
    .openapi(createWorkspaceRoute, async (c) => {
      const { name, id = crypto.randomUUID() } = c.req.valid("json");
      const result = await createWorkspace(db, {
        userId: c.get("user").id,
        id,
        name,
        now: platform.now(),
      });
      if (result === "name_taken") {
        return c.json(errorBody("workspace_exists", "workspace name is already used"), 409);
      }
      if (result === "id_taken") {
        return c.json(errorBody("workspace_id_taken", "workspace id is unavailable"), 409);
      }
      return c.json(
        { workspace: toWorkspaceResponse(result.workspace) },
        result.created ? 201 : 200,
      );
    })
    .openapi(updateRoute, async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const userId = c.get("user").id;
      if ("isDefault" in body) {
        const workspace = await setDefaultWorkspace(db, { userId, id });
        if (!workspace) {
          return c.json(errorBody("not_found", "workspace does not exist"), 404);
        }
        return c.json({ workspace: toWorkspaceResponse(workspace) }, 200);
      }
      const result = await renameWorkspace(db, { userId, id, name: body.name });
      if (result === "name_taken") {
        return c.json(errorBody("workspace_exists", "workspace name is already used"), 409);
      }
      if (result === "not_found") {
        return c.json(errorBody("not_found", "workspace does not exist"), 404);
      }
      return c.json({ workspace: toWorkspaceResponse(result.workspace) }, 200);
    })
    .openapi(deleteRoute, async (c) => {
      const { id } = c.req.valid("param");
      const result = await deleteWorkspace(db, {
        userId: c.get("user").id,
        id,
        now: platform.now(),
      });
      if (result === "is_default") {
        return c.json(errorBody("workspace_is_default", "workspace is the default"), 409);
      }
      if (result === "not_empty") {
        return c.json(errorBody("workspace_not_empty", "workspace still has subscriptions"), 409);
      }
      if (result === "not_found") {
        return c.json(errorBody("not_found", "workspace does not exist"), 404);
      }
      return c.body(null, 204);
    });
}
