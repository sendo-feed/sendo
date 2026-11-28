#!/usr/bin/env node
/**
 * 記事の解析に使う埋め込みのモデルを用意する（docs/decisions/article-analysis.md の 6）。
 *
 * models/potion-multilingual-128m.json に固定した版（コミットのハッシュ）のファイルを Hugging Face から
 * 取り、SHA-256 を確かめる。埋め込みの表を行ごとに int8 に縮め、行ごとの倍率を `weights` の表に
 * 入れたファイルに変換し、その SHA-256 も確かめる。どれかが合わなければ止める。
 * 取ってきた元のファイルは、置き場の .cache に残し、次からは取りにいかない（使うたびに SHA-256 を確かめる）。
 * 用意したディレクトリには、変換したファイルの SHA-256 を書いた印（.prepared.json）を置く。pnpm dev は
 * これを固定ファイルと比べ、版が古ければ止める。
 *
 *   pnpm model:prepare                        # models/potion-multilingual-128m に用意する
 *   node scripts/prepare-embedding-model.mjs --out /models/potion-multilingual-128m
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const lockFile = path.join(root, "models/potion-multilingual-128m.json");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    cache: { type: "string" },
  },
});
const lock = JSON.parse(await readFile(lockFile, "utf8"));
const out = path.resolve(values.out ?? path.join(root, "models/potion-multilingual-128m"));
const cache = path.resolve(values.cache ?? path.join(path.dirname(out), ".cache", lock.revision));

/** 取ってよいファイル。safetensors と JSON（とモデルカード）だけで、pickle の形式は取らない（記事の解析の 6） */
const ALLOWED_FILES = ["config.json", "model.safetensors", "README.md", "tokenizer.json"];
/** 1 つのファイルを取るのにかける時間の上限 */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

if (!/^[0-9a-f]{40}$/.test(lock.revision))
  throw new Error(`revision must be a commit hash: ${lock.revision}`);
if (!/^[\w.-]+\/[\w.-]+$/.test(lock.repository))
  throw new Error(`unexpected repository: ${lock.repository}`);
const names = Object.keys(lock.files).sort();
if (names.join() !== [...ALLOWED_FILES].sort().join())
  throw new Error(`files must be exactly ${ALLOWED_FILES.join(", ")}: ${names.join(", ")}`);
for (const [name, hash] of Object.entries({
  ...lock.files,
  converted: lock.converted["model.safetensors"],
})) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`SHA-256 must be 64 hex digits: ${name}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 固定した版のファイルを取り、SHA-256 を確かめる。置き場にあって合えば、取りにいかない */
async function fetchVerified(name, expected) {
  const file = path.join(cache, name);
  if (existsSync(file)) {
    const bytes = await readFile(file);
    if (sha256(bytes) === expected) return bytes;
  }
  const url = `https://huggingface.co/${lock.repository}/resolve/${lock.revision}/${name}`;
  console.error(`取りにいく: ${url}`);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  await mkdir(cache, { recursive: true });
  await writeFile(`${file}.tmp`, bytes);
  await rename(`${file}.tmp`, file);
  return bytes;
}

/** safetensors のヘッダーを読む */
function readHeader(bytes) {
  const length = Number(bytes.readBigUInt64LE(0));
  const header = JSON.parse(bytes.subarray(8, 8 + length).toString("utf8"));
  return { header, base: 8 + length };
}

/**
 * float32 の埋め込みの表を、行ごとの int8（対称、[-127, 127]）と、行ごとの倍率（`weights`、float32）に
 * 変換する。model2vec-rs は `weights` をトークンの重みとして掛けるので、行ごとの倍率として効く
 */
function quantize(bytes) {
  const { header, base } = readHeader(bytes);
  const tensors = Object.keys(header).filter((name) => name !== "__metadata__");
  if (tensors.includes("weights") || tensors.includes("mapping")) {
    throw new Error(
      "the source model already has weights or mapping; the conversion would misplace row scales",
    );
  }
  const embeddings = header.embeddings;
  if (!embeddings || tensors.length !== 1)
    throw new Error(`unexpected tensors: ${tensors.join(", ")}`);
  if (embeddings.dtype !== "F32" || embeddings.shape.length !== 2) {
    throw new Error(`unexpected embeddings: ${embeddings.dtype} ${embeddings.shape}`);
  }
  const [rows, cols] = embeddings.shape;
  const [start, end] = embeddings.data_offsets;
  if (end - start !== rows * cols * 4) throw new Error("embeddings size does not match its shape");
  const view = new DataView(bytes.buffer, bytes.byteOffset + base + start, end - start);
  const data = Buffer.alloc(rows * cols);
  const weights = Buffer.alloc(rows * 4);
  const row = new Float32Array(cols);
  for (let r = 0; r < rows; r++) {
    let max = 0;
    for (let c = 0; c < cols; c++) {
      const value = view.getFloat32((r * cols + c) * 4, true);
      row[c] = value;
      max = Math.max(max, Math.abs(value));
    }
    const scale = max === 0 ? 1 : max / 127;
    for (let c = 0; c < cols; c++) {
      const scaled = row[c] / scale;
      const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
      data.writeInt8(Math.max(-127, Math.min(127, rounded)), r * cols + c);
    }
    weights.writeFloatLE(Math.fround(scale), r * 4);
  }
  const headerJson = JSON.stringify({
    embeddings: { dtype: "I8", shape: [rows, cols], data_offsets: [0, data.length] },
    weights: {
      dtype: "F32",
      shape: [rows],
      data_offsets: [data.length, data.length + weights.length],
    },
  });
  const padded = headerJson.padEnd(Math.ceil(headerJson.length / 8) * 8, " ");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(Buffer.byteLength(padded)));
  return Buffer.concat([length, Buffer.from(padded, "utf8"), data, weights]);
}

const sources = {};
for (const [name, expected] of Object.entries(lock.files)) {
  sources[name] = await fetchVerified(name, expected);
}

const converted = quantize(sources["model.safetensors"]);
const convertedHash = sha256(converted);
const expectedConverted = lock.converted["model.safetensors"];
if (convertedHash !== expectedConverted) {
  throw new Error(
    `SHA-256 mismatch for the converted model: expected ${expectedConverted}, got ${convertedHash}`,
  );
}

// 一時ディレクトリに全部書いてから入れ替える。途中で落ちても、半端なファイルや、版の混ざった
// ディレクトリを残さない。書くのは、確かめたバイト列そのもの（置き場を読み直さない）
const staging = `${out}.tmp`;
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await writeFile(path.join(staging, "model.safetensors"), converted);
for (const name of ALLOWED_FILES.filter((n) => n !== "model.safetensors")) {
  await writeFile(path.join(staging, name), sources[name]);
}
await writeFile(
  path.join(staging, ".prepared.json"),
  `${JSON.stringify({ revision: lock.revision, converted: convertedHash }, null, 2)}\n`,
);
await rm(out, { recursive: true, force: true });
await rename(staging, out);
console.error(`用意した: ${out}`);
