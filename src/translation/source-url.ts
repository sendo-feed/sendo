/**
 * 同じ元記事を見分けるために、記事の URL を正規化する（docs/decisions/translation.md の 16）。
 * 表記の揺れ（スキーム、ホストの大小、既定のポート、ユーザー情報、フラグメント、末尾の `/`、計測用の
 * パラメータ）だけをそろえ、中身が変わりうるクエリは残す。
 */

/** 除く計測用のパラメータ（`utm_` で始まるものは、大文字と小文字を区別せずに別に除く） */
const TRACKING_PARAMS = new Set(["fbclid", "gclid"]);

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * 正規化した URL。使い回さない記事（URL がない、読めない、http ／ https でない、サイトの最初のページ）
 * は null
 */
export function normalizeSourceUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const port = DEFAULT_PORTS[parsed.protocol];
  if (port === undefined) return null;
  // 元のスキームの既定のポートを除いてから、スキームをそろえる
  const host = parsed.hostname.toLowerCase();
  const explicitPort = parsed.port === "" || parsed.port === port ? "" : `:${parsed.port}`;
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  // 生のクエリを & で分け、名前だけを見て計測用のものを除く（残すものの書き方は変えない）
  const params = parsed.search
    .slice(1)
    .split("&")
    .filter((part) => {
      if (part === "") return false;
      const name = decodeName(part.split("=", 1)[0] ?? "");
      return !name.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(name);
    });
  const query = params.length === 0 ? "" : `?${params.join("&")}`;
  // サイトの最初のページは、壊れたフィードですべての項目が指すことがあるので使い回さない
  if (path === "/" && query === "") return null;
  return `https://${host}${explicitPort}${path}${query}`;
}

/** パラメータの名前を読む（読めなければそのまま） */
function decodeName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}
