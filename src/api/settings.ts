import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { applySettings, DEVICE_TYPES, listSettings, SETTING_LIMITS } from "../db/settings";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody, SettingValueSchema } from "./schemas";

/*
 * クライアントの設定の API（docs/decisions/settings.md）。預かって配るだけで、中身は解釈しない。
 * ほかの端末の変更は、差分同期（sync.ts）で届く。
 */

/** リクエストの本文の大きさの上限 */
const MAX_BODY_BYTES = 1024 * 1024;

const DeviceTypeParamSchema = z.object({
  deviceType: z.enum(DEVICE_TYPES).openapi({
    param: { name: "deviceType", in: "path" },
    description: "端末の種類。どちらとして動くかは、クライアントが決める",
  }),
});

/** `<クライアント>.<残り>`。クライアントは英小文字で始まる英小文字・数字・ハイフン、残りは空白を除く印字できる ASCII */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}\.[\x21-\x7e]+$/;

const SettingNameSchema = z
  .string()
  .max(SETTING_LIMITS.nameLength)
  .regex(NAME_PATTERN)
  .openapi({
    description:
      "`<クライアント>.<残り>` の形。公式リーダーは `reader.` で始める。" +
      `${SETTING_LIMITS.nameLength} 文字まで、空白を除く印字できる ASCII`,
    example: "reader.theme",
  });

/** 配列とオブジェクトの入れ子の深さ（入れ子のない値は 0）。limit を超えたら、そこで数えるのをやめる */
function depthOf(value: unknown, limit: number): number {
  if (typeof value !== "object" || value === null) return 0;
  if (limit === 0) return 1;
  let deepest = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    deepest = Math.max(deepest, depthOf(child, limit - 1));
    if (deepest >= limit) break;
  }
  return deepest + 1;
}

const encoder = new TextEncoder();

const PutValueSchema = SettingValueSchema.refine((value) => value !== undefined, {
  message: "required",
})
  .refine((value) => depthOf(value, SETTING_LIMITS.valueDepth) <= SETTING_LIMITS.valueDepth, {
    message: `nested deeper than ${SETTING_LIMITS.valueDepth}`,
  })
  .refine(
    (value) =>
      value === undefined ||
      encoder.encode(JSON.stringify(value)).length <= SETTING_LIMITS.valueBytes,
    { message: `larger than ${SETTING_LIMITS.valueBytes} bytes as JSON` },
  )
  .openapi({
    description:
      `JSON の値。JSON にして ${SETTING_LIMITS.valueBytes} バイトまで、` +
      `入れ子は ${SETTING_LIMITS.valueDepth} 段まで。Sendo は中身を解釈しない`,
  });

const SettingSchema = z.object({ name: z.string(), value: SettingValueSchema }).openapi("Setting");

const PatchBodySchema = z
  .object({
    put: z
      .array(z.object({ name: SettingNameSchema, value: PutValueSchema }))
      .optional()
      .openapi({ description: "置く項目。なければ作り、あれば値を替える" }),
    remove: z
      .array(SettingNameSchema)
      .optional()
      .openapi({ description: "消す項目の名前。ない項目は、そのまま通す" }),
  })
  .superRefine((body, ctx) => {
    const names = [...(body.put ?? []).map((item) => item.name), ...(body.remove ?? [])];
    if (names.length > SETTING_LIMITS.requestItems) {
      ctx.addIssue({
        code: "custom",
        message: `put と remove は、合わせて ${SETTING_LIMITS.requestItems} 項目まで`,
      });
    }
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", message: "同じ名前は 1 度だけ" });
    }
  })
  .openapi("SettingsPatchRequest");

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const listRoute = createRoute({
  method: "get",
  path: "/settings/{deviceType}",
  summary: "設定の項目の一覧",
  description:
    "その端末の種類の、消していない項目をすべて返す。差分同期（/sync）を使うクライアントは、呼ばなくてよい。",
  request: { params: DeviceTypeParamSchema },
  responses: {
    200: {
      description: "項目（名前の順）",
      content: { "application/json": { schema: z.object({ items: z.array(SettingSchema) }) } },
    },
    400: error("端末の種類が mobile ／ desktop でない"),
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/settings/{deviceType}",
  summary: "設定の項目を置く ／ 消す",
  description: [
    "その端末の種類の項目を、まとめて置く ／ 消す。何度送り直しても同じ結果になる。",
    "同じ項目をほかの端末も変えていたら、あとから受けたほうを採る。項目ごとに比べるので、別の項目の変更は互いに消さない。",
    "今と同じ値を置いても、ない項目を消しても、何も変わらない（同期でも届かない）。",
    `項目の数（${SETTING_LIMITS.items}）か、名前と値の合計（${SETTING_LIMITS.totalBytes} バイト）を超えるなら、1 つも置かずに 409 を返す（remove は済んでいる）。`,
    "結果は、次の同期（/sync の settings）で届く。",
  ].join("\n"),
  middleware: [
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody("too_large", "request body is too large"), 413),
    }),
  ] as const,
  request: {
    params: DeviceTypeParamSchema,
    body: { required: true, content: { "application/json": { schema: PatchBodySchema } } },
  },
  responses: {
    204: { description: "置いた ／ 消した" },
    400: error(
      "名前の形が違う、値が大きすぎるか深すぎる、項目が多すぎる、同じ名前が 2 度ある、" +
        "端末の種類が mobile ／ desktop でない",
    ),
    409: error("項目の数か合計の上限を超える（settings_full）。項目を消せば置ける"),
    413: error("本文が大きすぎる"),
  },
});

export function settingsApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(listRoute, async (c) => {
      const { deviceType } = c.req.valid("param");
      const items = await listSettings(db, { userId: c.get("user").id, deviceType });
      return c.json(
        { items: items.map(({ name, json }) => ({ name, value: JSON.parse(json) as unknown })) },
        200,
      );
    })
    .openapi(patchRoute, async (c) => {
      const { deviceType } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await applySettings(db, {
        userId: c.get("user").id,
        deviceType,
        put: (body.put ?? []).map(({ name, value }) => ({ name, json: JSON.stringify(value) })),
        remove: body.remove ?? [],
        now: platform.now(),
      });
      if (result === "full") {
        return c.json(errorBody("settings_full", "too many or too large settings"), 409);
      }
      return c.body(null, 204);
    });
}
