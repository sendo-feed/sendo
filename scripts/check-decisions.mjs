import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "docs/decisions");
const index = "README.md";
const errors = [];

// 決定ファイルの本文だけを検査する。書式の例として置いたコードブロックは除く。
function readMarkdown(path) {
  return readFileSync(path, "utf8").replace(
    /^ {0,3}(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[\x60~]*[ \t]*$/gm,
    "",
  );
}

const documents = new Map(
  readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => [name, readMarkdown(join(directory, name))]),
);

const rows = new Set();
for (const [, name, cell] of (documents.get(index) ?? "").matchAll(
  /^\|\s*\[[^\]\n]+\]\(([^)\n]+)\)\s*\|([^|\n]+)\|/gm,
)) {
  if (rows.has(name)) errors.push(`一覧に同じ決定が複数ある: ${name}`);
  rows.add(name);
  const document = documents.get(name);
  if (document === undefined || name === index) {
    errors.push(`一覧に対応する決定ファイルがない: ${name}`);
    continue;
  }
  const state = /^- 状態：[ \t]*(提案中|合意済み)[ \t]*$/m.exec(document)?.[1];
  if (state !== cell.trim()) errors.push(`一覧と決定ファイルの状態が一致しない: ${name}`);
}
for (const name of documents.keys()) {
  if (name !== index && !rows.has(name)) errors.push(`一覧に決定が載っていない: ${name}`);
}
if (!documents.has(index)) errors.push("決定の一覧がない: docs/decisions/README.md");

const anchorsByFile = new Map();
function anchors(path) {
  const cached = anchorsByFile.get(path);
  if (cached) return cached;
  const ids = new Set();
  for (const [, heading] of readMarkdown(path).matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)#*[ \t]*$/gm)) {
    // リポジトリの Markdown 見出しで使う GitHub のアンカー形式に合わせる。
    const base = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "")
      .replace(/ /g, "-");
    let id = base;
    for (let suffix = 1; ids.has(id); suffix += 1) id = `${base}-${suffix}`;
    ids.add(id);
  }
  anchorsByFile.set(path, ids);
  return ids;
}

for (const [name, document] of documents) {
  const source = join(directory, name);
  const links = document.matchAll(
    /\[[^\]\n]*\]\((?:<([^>\n]+)>|((?:[^\s()\\]|\\[()]|\([^()\n]*\))+))(?:[ \t]+["'][^)\n]*["'])?[ \t]*\)/g,
  );
  for (const [, angle, plain] of links) {
    const url = angle ?? plain;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url)) continue;
    const [pathAndQuery, fragment] = url.split("#", 2);
    const [pathname] = pathAndQuery.split("?", 1);
    try {
      const target = pathname ? resolve(dirname(source), decodeURIComponent(pathname)) : source;
      if (
        relative(root, target).split(sep)[0] === ".." ||
        !statSync(target, { throwIfNoEntry: false })
      ) {
        errors.push(`${name} のリンク先がリポジトリ内にない: ${url}`);
      } else if (
        fragment &&
        target.endsWith(".md") &&
        !anchors(target).has(decodeURIComponent(fragment))
      ) {
        errors.push(`${name} のリンク先に見出しがない: ${url}`);
      }
    } catch (error) {
      errors.push(`${name} のリンクを確認できない: ${url} (${error.message})`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`決定の一覧と相対リンクを確認した (${documents.size} ファイル)`);
}
