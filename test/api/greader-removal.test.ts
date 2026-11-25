import { expect, it } from "vitest";
import { createTestPlatform, requestApp } from "../helpers";

it.each([
  ["GET", "/accounts/ClientLogin"],
  ["POST", "/accounts/ClientLogin"],
  ["GET", "/reader/api/0/user-info"],
  ["POST", "/reader/api/0/edit-tag"],
])("廃止した %s %s は通常の 404 を返す", async (method, path) => {
  const { platform } = createTestPlatform();
  const response = await requestApp(platform, path, { method });

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
});
