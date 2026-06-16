/**
 * gzip / gunzip via the native Compression Streams API (evergreen browsers +
 * Node 18+; no dependency). Used to keep stored GPX small on disk and to inflate
 * the gzipped GPX Beeline's storage hands back.
 *
 * The `"gzip"` codec is chosen (over `"deflate"`/`"deflate-raw"`) because it self-
 * describes with a magic header (`1f 8b`), which `gunzip` uses to pass already-
 * plain bytes through untouched.
 */

/** Gzip bytes. Returns a fresh `Uint8Array` of the compressed stream. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(bytes as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/**
 * Gunzip bytes via the native `DecompressionStream`. When the bytes lack the gzip
 * magic header (`1f 8b`) — e.g. a host that transparently decoded
 * `Content-Encoding: gzip` — they're returned unchanged so a plain GPX still parses.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
