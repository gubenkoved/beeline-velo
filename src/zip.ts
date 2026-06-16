/**
 * Dependency-free ZIP archive builder.
 *
 * A bulk GPX download used to fire one `<a download>` click per ride; browsers
 * throttle and silently drop rapid programmatic downloads, so selecting a whole
 * year only ever saved a handful of files. The fix is to hand the browser a SINGLE
 * file — a ZIP holding every ride's GPX — so one click delivers the whole batch.
 *
 * This builds a standard ZIP container with no third-party library, in keeping with
 * the app's dependency-light core value:
 *   - DEFLATE compression via the native `CompressionStream` (evergreen browsers +
 *     Node 18+). We use the universally-available `"deflate"` codec and strip its
 *     2-byte zlib header + 4-byte Adler-32 trailer to get the raw DEFLATE stream
 *     ZIP's method 8 expects. (`"deflate-raw"` would avoid the strip but only exists
 *     on Node 21.2+, which would break the Vitest run, so we don't rely on it.)
 *   - A per-entry STORE (method 0) fallback when compression doesn't actually shrink
 *     the bytes (e.g. already-tiny or incompressible payloads).
 *   - CRC-32 per entry, a central directory, and an end-of-central-directory record.
 *
 * No ZIP64: at the target scale (a power user's lifetime of rides) the archive and
 * every entry stay far under the 4 GB / 65535-entry classic-ZIP limits.
 */

// -- CRC-32 ------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

/** Lazily build (once) the standard CRC-32 lookup table (polynomial 0xEDB88320). */
function crcTableOnce(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 of a byte array (the checksum ZIP stores for each entry). */
export function crc32(bytes: Uint8Array): number {
  const table = crcTableOnce();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// -- raw DEFLATE -------------------------------------------------------------

/**
 * Compress bytes to a raw DEFLATE stream (no zlib wrapper) using the native
 * `CompressionStream("deflate")`, then stripping the 2-byte zlib header and the
 * 4-byte Adler-32 trailer it adds — leaving exactly what ZIP method 8 wants.
 */
export async function rawDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(bytes as BufferSource);
  void writer.close();
  const zlib = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  // zlib framing: 2-byte header + raw DEFLATE payload + 4-byte Adler-32 checksum.
  // Strip both ends to recover the bare DEFLATE stream.
  return zlib.subarray(2, zlib.length - 4);
}

// -- ZIP container -----------------------------------------------------------

/** One file to place in the archive. */
export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

interface PreparedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  method: number; // 0 = store, 8 = deflate
  crc: number;
  compSize: number;
  uncompSize: number;
  offset: number;
}

const encoder = new TextEncoder();

/** Ensure entry names are unique by suffixing " (2)", " (3)", … before the extension. */
function dedupeNames(entries: ZipEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const count = seen.get(e.name) ?? 0;
    seen.set(e.name, count + 1);
    if (count === 0) return e.name;
    const dot = e.name.lastIndexOf(".");
    const n = count + 1;
    return dot > 0
      ? `${e.name.slice(0, dot)} (${n})${e.name.slice(dot)}`
      : `${e.name} (${n})`;
  });
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/**
 * Build a ZIP archive (as bytes) from a list of named files. Each entry is DEFLATE-
 * compressed unless that wouldn't shrink it, in which case it's stored verbatim.
 * Duplicate names are disambiguated. Returns a single `Uint8Array` ready to wrap in
 * a Blob for download.
 */
export async function buildZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const names = dedupeNames(entries);
  const prepared: PreparedEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i].bytes;
    const crc = crc32(raw);
    let method = 0;
    let data = raw;
    if (raw.length > 0) {
      const deflated = await rawDeflate(raw);
      // Only pay the deflate header overhead when it actually saves space.
      if (deflated.length < raw.length) {
        method = 8;
        data = deflated;
      }
    }
    prepared.push({
      nameBytes: encoder.encode(names[i]),
      data,
      method,
      crc,
      compSize: data.length,
      uncompSize: raw.length,
      offset: 0,
    });
  }

  const localChunks: Uint8Array[] = [];
  let offset = 0;
  for (const e of prepared) {
    e.offset = offset;
    const header = [
      ...u32(0x04034b50), // local file header signature
      ...u16(20), // version needed to extract (2.0)
      ...u16(0x0800), // general purpose flag: bit 11 = UTF-8 filename
      ...u16(e.method),
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(e.crc),
      ...u32(e.compSize),
      ...u32(e.uncompSize),
      ...u16(e.nameBytes.length),
      ...u16(0), // extra field length
    ];
    const head = new Uint8Array(header);
    localChunks.push(head, e.nameBytes, e.data);
    offset += head.length + e.nameBytes.length + e.data.length;
  }

  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const e of prepared) {
    const header = [
      ...u32(0x02014b50), // central directory header signature
      ...u16(20), // version made by
      ...u16(20), // version needed to extract
      ...u16(0x0800), // flags: UTF-8 filename
      ...u16(e.method),
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(e.crc),
      ...u32(e.compSize),
      ...u32(e.uncompSize),
      ...u16(e.nameBytes.length),
      ...u16(0), // extra field length
      ...u16(0), // file comment length
      ...u16(0), // disk number start
      ...u16(0), // internal file attributes
      ...u32(0), // external file attributes
      ...u32(e.offset),
    ];
    const head = new Uint8Array(header);
    centralChunks.push(head, e.nameBytes);
    centralSize += head.length + e.nameBytes.length;
  }

  const eocd = new Uint8Array([
    ...u32(0x06054b50), // end of central directory signature
    ...u16(0), // number of this disk
    ...u16(0), // disk with central directory
    ...u16(prepared.length), // entries on this disk
    ...u16(prepared.length), // total entries
    ...u32(centralSize), // central directory size
    ...u32(offset), // central directory offset
    ...u16(0), // comment length
  ]);

  const total =
    offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of localChunks) {
    out.set(c, pos);
    pos += c.length;
  }
  for (const c of centralChunks) {
    out.set(c, pos);
    pos += c.length;
  }
  out.set(eocd, pos);
  return out;
}
