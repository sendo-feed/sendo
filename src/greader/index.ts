import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { getFeed } from "../db/feeds";
import {
  deleteFolder,
  ensureFolders,
  FolderNameTakenError,
  listFolders,
  normalizeFolderName,
  renameFolder,
} from "../db/folders";
import {
  countUnreadWithNewest,
  getItemsByItemIds,
  listStreamItems,
  type StreamFilter,
  type StreamPosition,
  setItemsState,
} from "../db/greader";
import { type MarkReadScope, markArticlesRead } from "../db/inbox";
import type { User } from "../db/schema";
import {
  listSubscriptions,
  removeSubscriptionFromFolder,
  setSubscriptionFolder,
  unsubscribe,
} from "../db/subscriptions";
import { authenticateToken } from "../db/tokens";
import { subscribeFeed, subscribeToUrl } from "../feeds/subscribe";
import { DiscoverError } from "../fetcher/discover";
import { UrlNotAllowedError } from "../fetcher/url-guard";
import { base64UrlDecode, base64UrlEncode, sha256 } from "../lib/crypto";
import { readLimited, TooLargeError } from "../lib/read-limited";
import type { Platform } from "../platform";
import {
  feedStreamId,
  labelStreamId,
  parseItemId,
  parseStreamId,
  READING_LIST,
  STARRED,
  type Stream,
} from "./ids";
import { toReaderItem } from "./items";

/*
 * Google Reader API 互換（docs/decisions/greader.md）。Reeder や NetNewsWire などのリーダーアプリから
 * 使う。入口は /accounts/ClientLogin と /reader/api/0/...。
 *
 * 状態を変える操作は、REST API と同じ処理（db/、feeds/）に任せる（決定の 5）。
 */

type Variables = { user: User; token: string };
type ReaderContext = Context<{ Variables: Variables }>;

/** 本文の大きさの上限。ClientLogin は認証の前に読むので、大きな本文でメモリを使わせない */
const MAX_BODY_BYTES = 1024 * 1024;

/** 1 回で扱う記事の数の上限（stream/items/ids の n、stream/items/contents と edit-tag の i） */
const MAX_ITEMS = 1000;

/** n を付けなかったときの数 */
const DEFAULT_ITEMS = 20;

/**
 * リクエストの値を読む。クエリとフォームの本文の両方から読み、同じ名前を何度も送ってきたもの
 * （i=...&i=...）はすべて残す。
 */
async function readParams(c: Context): Promise<URLSearchParams> {
  const params = new URL(c.req.url).searchParams;
  const type = c.req.header("content-type") ?? "";
  if (
    c.req.method === "POST" &&
    (type === "" ||
      type.startsWith("application/x-www-form-urlencoded") ||
      type.startsWith("text/plain"))
  ) {
    const body = await readLimited(
      c.req.raw.body,
      c.req.header("content-length") ?? null,
      MAX_BODY_BYTES,
    );
    for (const [key, value] of new URLSearchParams(new TextDecoder().decode(body))) {
      params.append(key, value);
    }
  }
  return params;
}

const badRequest = (c: Context, message: string) => c.text(`Error=${message}\n`, 400);

function onError(err: Error, c: Context) {
  if (err instanceof TooLargeError) return c.text("Error=TooLarge\n", 413);
  console.error(err);
  return c.text("Error=InternalError\n", 500);
}

/** 続き（c）。中身は最後に返した記事の位置で、リーダーアプリには意味を持たせない（決定の 7） */
const ContinuationSchema = z.object({ p: z.number().int(), a: z.string().min(1).max(64) });

function encodeContinuation(position: StreamPosition): string {
  return base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ p: position.publishedAt, a: position.articleId })),
  );
}

function decodeContinuation(value: string): StreamPosition | undefined {
  const bytes = base64UrlDecode(value);
  if (!bytes) return undefined;
  try {
    const parsed = ContinuationSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? { publishedAt: parsed.data.p, articleId: parsed.data.a } : undefined;
  } catch {
    return undefined;
  }
}

/** 0 以上の整数の値。なければ undefined、形が違えば null */
function readInteger(params: URLSearchParams, name: string): number | undefined | null {
  const value = params.get(name);
  if (value === null || value === "") return undefined;
  if (!/^[0-9]{1,16}$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

/** 送ってきたアイテムの ID（i）を読む。形の違うものがあれば null */
function readItemIds(params: URLSearchParams): number[] | null {
  const ids: number[] = [];
  for (const value of params.getAll("i")) {
    const id = parseItemId(value);
    if (id === undefined) return null;
    ids.push(id);
  }
  return ids;
}

/** Authorization: GoogleLogin auth=<トークン>（Bearer も受ける）で認証する（決定の 2） */
function readerAuth(platform: Platform): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = /^(?:GoogleLogin\s+auth=|Bearer\s+)(\S+)\s*$/i.exec(header)?.[1];
    const auth =
      token === undefined
        ? undefined
        : await authenticateToken(platform.db, { token, now: platform.now() });
    if (!auth || token === undefined) return c.text("Unauthorized\n", 401);
    c.set("user", auth.user);
    c.set("token", token);
    return next();
  };
}

export function greaderApp(platform: Platform) {
  const { db } = platform;
  const app = new Hono<{ Variables: Variables }>();
  app.onError(onError);

  /**
   * ログイン。Email はユーザーのメール、Passwd はそのユーザーのアクセストークン（アプリ用パスワード）。
   * 両方が合えば、SID、LSID、Auth に同じトークンを入れて返す（決定の 2）。リーダーアプリによっては
   * GET のクエリで送ってくるので、GET も受ける。
   */
  app.on(["GET", "POST"], "/accounts/ClientLogin", async (c) => {
    const params = await readParams(c);
    const email = params.get("Email")?.trim().toLowerCase();
    const password = params.get("Passwd");
    const auth =
      email && password
        ? await authenticateToken(db, { token: password, now: platform.now() })
        : undefined;
    // メールも合わなければ受けない。ほかの人のトークンで、別の人としてログインさせない
    if (!auth || !password || auth.user.email !== email) {
      return c.text("Error=BadAuthentication\n", 401);
    }
    if (params.get("output") === "json") {
      return c.json({ SID: password, LSID: password, Auth: password });
    }
    return c.text(`SID=${password}\nLSID=${password}\nAuth=${password}\n`);
  });

  const api = new Hono<{ Variables: Variables }>();
  api.onError(onError);
  api.use("*", readerAuth(platform));

  /** 書き込みに付ける T。配るが確かめない（決定の 2）。トークンから作るので、毎回同じ値になる */
  api.get("/token", async (c) => {
    return c.text(base64UrlEncode(await sha256(`greader-t:${c.get("token")}`)).slice(0, 40));
  });

  api.get("/user-info", (c) => {
    const user = c.get("user");
    return c.json({
      userId: user.id,
      userName: user.email,
      userProfileId: user.id,
      userEmail: user.email,
      isBloggerUser: false,
      signupTimeSec: Math.floor(user.createdAt.getTime() / 1000),
      isMultiLoginEnabled: false,
    });
  });

  api.get("/tag/list", async (c) => {
    const folders = await listFolders(db, c.get("user").id);
    return c.json({
      tags: [
        { id: STARRED },
        ...folders.map((folder) => ({ id: labelStreamId(folder.name), type: "folder" })),
      ],
    });
  });

  api.get("/subscription/list", async (c) => {
    const subscriptions = await listSubscriptions(db, c.get("user").id);
    return c.json({
      subscriptions: subscriptions.map((subscription) => ({
        id: feedStreamId(subscription.feed.id),
        title: subscription.feed.title ?? subscription.feed.url,
        categories:
          subscription.folderName === null
            ? []
            : [{ id: labelStreamId(subscription.folderName), label: subscription.folderName }],
        url: subscription.feed.url,
        htmlUrl: subscription.feed.siteUrl ?? subscription.feed.url,
        iconUrl: "",
      })),
    });
  });

  api.get("/unread-count", async (c) => {
    const userId = c.get("user").id;
    const counts = await countUnreadWithNewest(db, userId);
    const subscriptions = await listSubscriptions(db, userId);
    const folderOf = new Map(subscriptions.map((s) => [s.feed.id, s.folderName]));
    const usec = (date: Date | null) => String((date?.getTime() ?? 0) * 1000);
    const labels = new Map<string, { count: number; newest: Date | null }>();
    let total = 0;
    let newest: Date | null = null;
    const later = (a: Date | null, b: Date | null) => (a === null || (b !== null && b > a) ? b : a);
    for (const row of counts) {
      total += row.count;
      newest = later(newest, row.newestReceivedAt);
      const folder = folderOf.get(row.feedId);
      if (folder) {
        const label = labels.get(folder) ?? { count: 0, newest: null };
        labels.set(folder, {
          count: label.count + row.count,
          newest: later(label.newest, row.newestReceivedAt),
        });
      }
    }
    return c.json({
      max: total,
      unreadcounts: [
        ...counts.map((row) => ({
          id: feedStreamId(row.feedId),
          count: row.count,
          newestItemTimestampUsec: usec(row.newestReceivedAt),
        })),
        ...[...labels].map(([name, label]) => ({
          id: labelStreamId(name),
          count: label.count,
          newestItemTimestampUsec: usec(label.newest),
        })),
        { id: READING_LIST, count: total, newestItemTimestampUsec: usec(newest) },
      ],
    });
  });

  /** フォルダの名前から、そのユーザーのフォルダの ID を引く */
  const findFolderId = async (userId: string, name: string) =>
    (await listFolders(db, userId)).find((folder) => folder.name === name)?.id;

  /**
   * ストリームを、記事の絞り込みにする。ないフォルダなど、記事が 1 件もないストリームは null
   */
  const toFilter = async (userId: string, stream: Stream): Promise<StreamFilter | null> => {
    switch (stream.kind) {
      case "reading-list":
        return {};
      case "read":
        return { only: "read" };
      case "starred":
        return { only: "starred" };
      case "kept-unread":
        return { exclude: ["read"] };
      case "feed":
        return { feedId: stream.feedId };
      case "label": {
        const folderId = await findFolderId(userId, stream.name);
        return folderId === undefined ? null : { folderId };
      }
    }
  };

  /**
   * ストリームの記事を、公開日時の順に読む（stream/items/ids と stream/contents で共通）。
   * - n：数（既定 20、最大 1000）。r=o なら古い順
   * - xt：除く状態（read なら未読だけ）。it：この状態だけ
   * - ot ／ nt：受信箱に入った時刻（秒）で、ot 以降、nt より前に絞る
   * - c：続き
   */
  const readStream = async (c: ReaderContext, params: URLSearchParams, streamId: string) => {
    const stream = parseStreamId(streamId);
    if (!stream) return badRequest(c, "UnknownStream");
    const n = readInteger(params, "n");
    const ot = readInteger(params, "ot");
    const nt = readInteger(params, "nt");
    if (n === null || ot === null || nt === null) return badRequest(c, "InvalidParameter");
    const continuation = params.get("c");
    const after = continuation ? decodeContinuation(continuation) : undefined;
    if (continuation && !after) return badRequest(c, "InvalidContinuation");

    const userId = c.get("user").id;
    const filter = await toFilter(userId, stream);
    if (filter === null) return { items: [], continuation: undefined };
    const exclude = new Set(filter.exclude);
    for (const value of params.getAll("xt")) {
      const kind = parseStreamId(value)?.kind;
      if (kind === "read" || kind === "starred") exclude.add(kind);
    }
    let only = filter.only;
    for (const value of params.getAll("it")) {
      const kind = parseStreamId(value)?.kind;
      if (only === undefined && (kind === "read" || kind === "starred")) only = kind;
    }

    const page = await listStreamItems(db, {
      userId,
      filter: { ...filter, only, exclude: [...exclude] },
      receivedSince: ot === undefined ? undefined : new Date(ot * 1000),
      receivedBefore: nt === undefined ? undefined : new Date(nt * 1000),
      order: params.get("r") === "o" ? "oldest" : "newest",
      limit: Math.min(Math.max(n ?? DEFAULT_ITEMS, 1), MAX_ITEMS),
      after,
    });
    return {
      items: page.items,
      continuation: page.next === null ? undefined : encodeContinuation(page.next),
    };
  };

  /** アイテムの ID で記事を引き、Google Reader API の形にする（頼まれた順） */
  const loadItems = async (userId: string, itemIds: readonly number[]) => {
    const items = await getItemsByItemIds(db, { userId, itemIds });
    const subscriptions = await listSubscriptions(db, userId);
    const folderOf = new Map(subscriptions.map((s) => [s.feed.id, s.folderName]));
    const byId = new Map(items.map((item) => [item.itemId, item]));
    return itemIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [toReaderItem(item, folderOf.get(item.feedId) ?? null)] : [];
    });
  };

  api.get("/stream/items/ids", async (c) => {
    const params = await readParams(c);
    const result = await readStream(c, params, params.get("s") ?? READING_LIST);
    if (result instanceof Response) return result;
    return c.json({
      itemRefs: result.items.map((item) => ({
        id: String(item.itemId),
        directStreamIds: [],
        timestampUsec: String(item.receivedAt.getTime() * 1000),
      })),
      ...(result.continuation !== undefined && { continuation: result.continuation }),
    });
  });

  api.on(["GET", "POST"], "/stream/items/contents", async (c) => {
    const params = await readParams(c);
    const itemIds = readItemIds(params);
    if (itemIds === null) return badRequest(c, "InvalidItemId");
    if (itemIds.length === 0) return badRequest(c, "MissingItemId");
    if (itemIds.length > MAX_ITEMS) return badRequest(c, "TooManyItems");
    return c.json({
      id: READING_LIST,
      updated: Math.floor(platform.now().getTime() / 1000),
      items: await loadItems(c.get("user").id, itemIds),
    });
  });

  /** ストリームの記事を、中身まで返す。ストリームの ID はパスの続きか s で渡す */
  api.get("/stream/contents/*", async (c) => {
    const params = await readParams(c);
    const rest = c.req.path.replace(/^.*?\/stream\/contents\/?/, "");
    let streamId: string;
    try {
      streamId = rest === "" ? (params.get("s") ?? READING_LIST) : decodeURIComponent(rest);
    } catch {
      return badRequest(c, "UnknownStream");
    }
    const result = await readStream(c, params, streamId);
    if (result instanceof Response) return result;
    return c.json({
      id: streamId,
      updated: Math.floor(platform.now().getTime() / 1000),
      items: await loadItems(
        c.get("user").id,
        result.items.map((item) => item.itemId),
      ),
      ...(result.continuation !== undefined && { continuation: result.continuation }),
    });
  });

  /** 既読（read）、スター（starred）の付け外し。kept-unread を付けたら未読にする（決定の 5） */
  api.post("/edit-tag", async (c) => {
    const params = await readParams(c);
    const itemIds = readItemIds(params);
    if (itemIds === null) return badRequest(c, "InvalidItemId");
    if (itemIds.length > MAX_ITEMS) return badRequest(c, "TooManyItems");
    let read: boolean | undefined;
    let starred: boolean | undefined;
    for (const value of params.getAll("a")) {
      const kind = parseStreamId(value)?.kind;
      if (kind === "read") read = true;
      if (kind === "kept-unread") read = false;
      if (kind === "starred") starred = true;
    }
    for (const value of params.getAll("r")) {
      const kind = parseStreamId(value)?.kind;
      if (kind === "read") read = false;
      if (kind === "starred") starred = false;
    }
    await setItemsState(db, {
      userId: c.get("user").id,
      itemIds,
      read,
      starred,
      now: platform.now(),
    });
    return c.text("OK");
  });

  /** ストリームの記事を、ts（マイクロ秒）より前に受信箱に入ったものだけ既読にする（決定の 5） */
  api.post("/mark-all-as-read", async (c) => {
    const params = await readParams(c);
    const stream = parseStreamId(params.get("s") ?? "");
    if (!stream) return badRequest(c, "UnknownStream");
    const ts = readInteger(params, "ts");
    if (ts === null) return badRequest(c, "InvalidParameter");
    const now = platform.now();
    const until = ts === undefined ? now : new Date(Math.floor(ts / 1000));
    const userId = c.get("user").id;

    let scope: MarkReadScope | undefined;
    if (stream.kind === "reading-list") scope = { all: true, until };
    if (stream.kind === "feed") scope = { feedId: stream.feedId, until };
    if (stream.kind === "label") {
      const folderId = await findFolderId(userId, stream.name);
      if (folderId !== undefined) scope = { folderId, until };
    }
    // スター付きなど、ほかのストリームは受けるだけ
    if (scope) await markArticlesRead(db, { userId, scope, now });
    return c.text("OK");
  });

  /** URL（フィードかサイト）から購読する */
  api.post("/subscription/quickadd", async (c) => {
    const params = await readParams(c);
    const query = params.get("quickadd")?.trim() ?? "";
    if (query === "") return badRequest(c, "MissingQuery");
    const url = query.startsWith("feed/") ? query.slice("feed/".length) : query;
    try {
      const { subscription } = await subscribeToUrl(platform, {
        userId: c.get("user").id,
        url,
        folderId: null,
      });
      return c.json({
        numResults: 1,
        query,
        streamId: feedStreamId(subscription.feed.id),
        streamName: subscription.feed.title ?? subscription.feed.url,
      });
    } catch (e) {
      if (e instanceof UrlNotAllowedError || e instanceof DiscoverError) {
        return c.json({ numResults: 0, query, error: e.message });
      }
      throw e;
    }
  });

  /**
   * 購読の変更。ac=subscribe（購読）、unsubscribe（やめる）、edit（フォルダの付け替え）。
   * a=user/-/label/<名前> でそのフォルダに入れ（なければ作る）、r で外す。名前の付け直し（t）は、
   * 人ごとの名前を持つまで受けるだけ（決定の 5）。
   */
  api.post("/subscription/edit", async (c) => {
    const params = await readParams(c);
    const action = params.get("ac") ?? "edit";
    const userId = c.get("user").id;
    const now = platform.now();
    const labelOf = (name: string) => {
      const stream = parseStreamId(params.get(name) ?? "");
      return stream?.kind === "label" ? normalizeFolderName(stream.name) : null;
    };
    const addTo = labelOf("a");
    const removeFrom = labelOf("r");
    const folderId =
      addTo === null
        ? undefined
        : (await ensureFolders(db, { userId, names: [addTo], now })).get(addTo);

    for (const value of params.getAll("s")) {
      const stream = parseStreamId(value);
      if (stream?.kind !== "feed") return badRequest(c, "UnknownStream");
      if (action === "subscribe") {
        // feed/<フィードの ID> ならそのフィード、そうでなければ feed/<URL> として購読する
        const feed = await getFeed(db, stream.feedId);
        try {
          if (feed) {
            await subscribeFeed(platform, {
              userId,
              feed,
              feedCreated: false,
              folderId: folderId ?? null,
            });
          } else {
            await subscribeToUrl(platform, {
              userId,
              url: stream.feedId,
              folderId: folderId ?? null,
            });
          }
        } catch (e) {
          if (e instanceof UrlNotAllowedError || e instanceof DiscoverError) {
            return badRequest(c, "SubscribeFailed");
          }
          throw e;
        }
      } else if (action === "unsubscribe") {
        await unsubscribe(db, { userId, feedId: stream.feedId, now });
      } else if (action === "edit") {
        if (folderId !== undefined) {
          await setSubscriptionFolder(db, { userId, feedId: stream.feedId, folderId });
        } else if (removeFrom !== null) {
          const removeFromId = await findFolderId(userId, removeFrom);
          if (removeFromId !== undefined) {
            await removeSubscriptionFromFolder(db, {
              userId,
              feedId: stream.feedId,
              folderId: removeFromId,
            });
          }
        }
      } else {
        return badRequest(c, "UnknownAction");
      }
    }
    return c.text("OK");
  });

  /** フォルダの名前を変える */
  api.post("/rename-tag", async (c) => {
    const params = await readParams(c);
    const from = parseStreamId(params.get("s") ?? "");
    const to = parseStreamId(params.get("dest") ?? "");
    if (from?.kind !== "label" || to?.kind !== "label") return badRequest(c, "UnknownStream");
    const name = normalizeFolderName(to.name);
    if (name === null) return badRequest(c, "InvalidName");
    const userId = c.get("user").id;
    const folderId = await findFolderId(userId, from.name);
    if (folderId === undefined) return badRequest(c, "UnknownStream");
    try {
      await renameFolder(db, { userId, id: folderId, name });
    } catch (e) {
      if (e instanceof FolderNameTakenError) return badRequest(c, "NameTaken");
      throw e;
    }
    return c.text("OK");
  });

  /** フォルダを消す（中の購読はフォルダなしになる） */
  api.post("/disable-tag", async (c) => {
    const params = await readParams(c);
    const stream = parseStreamId(params.get("s") ?? "");
    if (stream?.kind !== "label") return badRequest(c, "UnknownStream");
    const userId = c.get("user").id;
    const folderId = await findFolderId(userId, stream.name);
    if (folderId !== undefined) {
      await deleteFolder(db, { userId, id: folderId, now: platform.now() });
    }
    return c.text("OK");
  });

  api.all("*", (c) => c.text("Not Found\n", 404));

  app.route("/reader/api/0", api);
  return app;
}
