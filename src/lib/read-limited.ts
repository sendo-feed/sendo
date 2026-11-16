export class TooLargeError extends Error {
  override readonly name = "TooLargeError";
}

/**
 * 本文を、決めた大きさまでしか読まない。外から来る本文で、メモリを使い切らないようにする。
 *
 * Content-Length が上限を超えていれば読まずに止め、なくても（嘘でも）読んだ量で止める。
 */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(contentLength);
  if (contentLength !== null && Number.isFinite(declared) && declared > maxBytes) {
    await body?.cancel();
    throw new TooLargeError(`content-length ${declared} exceeds ${maxBytes} bytes`);
  }
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeError(`body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

/**
 * 本文の先頭を、決めた大きさまで読む。超えた分は読まずに捨てる（readLimited と違い、例外にしない）。
 * robots.txt のように、先頭だけを使えばよいものに使う
 */
export async function readPrefix(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(), truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { bytes: concat(chunks, total), truncated };
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
