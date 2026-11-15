import { z } from "zod";
import { getRegisteredClient } from "../db/oauth";
import { USER_AGENT } from "../fetcher/fetch-feed";
import { toFetchableUrl, UrlNotAllowedError } from "../fetcher/url-guard";
import { readLimited } from "../lib/read-limited";
import type { Platform } from "../platform";

/*
 * OAuth のクライアント（docs/decisions/mcp.md の 5）。
 *
 * - Client ID Metadata Document：client_id が https の URL。Sendo がその URL から、クライアントの
 *   名前とリダイレクト先を取りにいく（取りにいくたびに。キャッシュはしない）
 * - 動的登録（RFC 7591）：Sendo が client_id を振り、DB に置く（db/oauth.ts）
 *
 * どちらも公開クライアント（秘密なし）だけ。リダイレクト先は、https か、手元（localhost など）の http だけ。
 */

/** client_id とリダイレクト先の長さの上限 */
export const MAX_URI_LENGTH = 2048;

/** クライアントの名前の長さの上限 */
export const MAX_CLIENT_NAME_LENGTH = 200;

/** 1 つのクライアントが持てるリダイレクト先の数 */
export const MAX_REDIRECT_URIS = 20;

/** Client ID Metadata Document の大きさの上限（ドラフトの 6.6 が勧める 5 KB） */
const METADATA_DOCUMENT_MAX_BYTES = 5 * 1024;

/** Client ID Metadata Document を取りにいくときの待ち時間 */
const METADATA_DOCUMENT_TIMEOUT_MS = 5_000;

/** 手元（ループバック）のホスト。http のリダイレクト先は、これだけを受ける */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** クライアントを確かめられなかった（不明、取りにいけない、中身が正しくない） */
export class ClientError extends Error {
  override readonly name = "ClientError";
}

/** 認可のリクエストを確かめるのに使う、クライアントの情報 */
export type ResolvedClient = {
  id: string;
  /** 名前。動的登録なら、クライアントが名乗っただけで確かめていない */
  name: string | null;
  kind: "metadata_document" | "registered";
  /**
   * Client ID Metadata Document の URL のホスト。許可の画面に出し、なりすましを見分ける手がかりにする
   * （ドラフトの 6.4）。動的登録なら null
   */
  host: string | null;
  redirectUris: readonly string[];
};

/**
 * リダイレクト先として受けられる URI か。https か、ループバックのホストの http で、
 * フラグメントとユーザー名のないもの（MCP の仕様の「Communication Security」）
 */
export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > MAX_URI_LENGTH || value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}

/** ループバックのホストへのリダイレクトか。ほかのアプリでも受けられるので、許可の画面で注意を出す */
export function isLoopbackRedirectUri(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** client_id が Client ID Metadata Document の URL か（動的登録の ID は https で始まらない） */
export function isMetadataDocumentClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

const MetadataDocumentSchema = z.looseObject({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(MAX_CLIENT_NAME_LENGTH),
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  token_endpoint_auth_method: z.string().optional(),
});

/**
 * client_id から、クライアントの情報を得る。確かめられなければ ClientError。
 * Client ID Metadata Document なら、その URL を取りにいく（SSRF の確認を通す）
 */
export async function resolveClient(
  platform: Pick<Platform, "db" | "fetch">,
  clientId: string,
): Promise<ResolvedClient> {
  if (clientId.length > MAX_URI_LENGTH) throw new ClientError("client_id is too long");
  if (isMetadataDocumentClientId(clientId)) return fetchMetadataDocument(platform, clientId);

  const client = await getRegisteredClient(platform.db, clientId);
  if (!client) throw new ClientError("unknown client_id");
  return {
    id: client.id,
    name: client.name,
    kind: "registered",
    host: null,
    redirectUris: client.redirectUris,
  };
}

async function fetchMetadataDocument(
  platform: Pick<Platform, "fetch">,
  clientId: string,
): Promise<ResolvedClient> {
  // ドラフトの 3：https で、パスがあり、. や .. のセグメント・フラグメント・ユーザー名がない。
  // URL の正規化で変わる形（ホストの大文字、既定のポート、. や .. など）も受けない
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientError("client_id is not a valid URL");
  }
  if (url.href !== clientId || url.pathname === "/" || url.username !== "" || url.hash !== "") {
    throw new ClientError("client_id must be a normalized https URL with a path");
  }
  try {
    url = toFetchableUrl(url);
  } catch (error) {
    if (error instanceof UrlNotAllowedError) throw new ClientError(`client_id: ${error.message}`);
    throw error;
  }

  let body: unknown;
  try {
    // リダイレクトはたどらない（取りにいった URL と、文書の client_id を一致させる）
    const res = await platform.fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(METADATA_DOCUMENT_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new ClientError(`client metadata document: unexpected status ${res.status}`);
    }
    const bytes = await readLimited(
      res.body,
      res.headers.get("content-length"),
      METADATA_DOCUMENT_MAX_BYTES,
    );
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      `client metadata document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = MetadataDocumentSchema.safeParse(body);
  if (!parsed.success) throw new ClientError("client metadata document: invalid document");
  const document = parsed.data;
  // ドラフトの 4.1：文書の client_id は、取りにいった URL と同じ文字列でなければならない
  if (document.client_id !== clientId) {
    throw new ClientError("client metadata document: client_id does not match the URL");
  }
  // 秘密を使うクライアントは受けない（公開クライアントだけ）
  if ("client_secret" in document || "client_secret_expires_at" in document) {
    throw new ClientError("client metadata document: client_secret must not be used");
  }
  const method = document.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    throw new ClientError(`client metadata document: unsupported auth method ${method}`);
  }
  return {
    id: clientId,
    name: document.client_name,
    kind: "metadata_document",
    host: url.host,
    redirectUris: document.redirect_uris,
  };
}
