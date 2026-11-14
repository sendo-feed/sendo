import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";

const UserSchema = z
  .object({
    id: z.string(),
    email: z.string().openapi({ example: "you@example.com" }),
  })
  .openapi("User");

const meRoute = createRoute({
  method: "get",
  path: "/me",
  summary: "認証しているユーザー",
  description: "ブラウザでは、ログインしているかを確かめるのに使う（していなければ 401）。",
  responses: {
    200: {
      description: "ユーザー",
      content: { "application/json": { schema: z.object({ user: UserSchema }) } },
    },
  },
});

export function meApi() {
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook }).openapi(meRoute, (c) => {
    const { id, email } = c.get("user");
    return c.json({ user: { id, email } }, 200);
  });
}
