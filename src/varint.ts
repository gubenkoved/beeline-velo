/**
 * LEB128 variable-length integer codec over a growable byte buffer.
 *
 * This is the same delta-friendly technique the Google-polyline encoder uses
 * (see `encodeSigned` in track.ts: zig-zag a signed value, then emit 7 bits per
 * byte low-to-high with a continuation flag). It's lifted here into one canonical,
 * reusable codec so the columnar location-history encoder (loc-codec.ts) and any
 * future binary column share a single implementation rather than re-deriving the
 * bit-twiddling — two copies would mean two behaviours, and a corrupted byte
 * stream is invisible until it's mis-decoded.
 *
 * - Unsigned values use plain LEB128 (`writeUvarint`/`readUvarint`).
 * - Signed values are zig-zag mapped first (`zigzag`/`unzigzag`) so small-magnitude
 *   negatives (e.g. a backward coordinate delta) stay one byte.
 *
 * Values are limited to the safe-integer range; callers that need to store
 * milliseconds or E7 coordinates (which exceed 32 bits) rely on this using
 * arithmetic (not bitwise) math above the 32-bit boundary.
 */

/** A growable little byte sink for sequential varint writes. */
export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 64) {
    this.buf = new Uint8Array(Math.max(8, initialCapacity));
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Append one raw byte (0–255). */
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  /** Append an unsigned LEB128 integer (non-negative, ≤ Number.MAX_SAFE_INTEGER). */
  uvarint(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`uvarint expects a non-negative finite number, got ${value}`);
    }
    let v = Math.trunc(value);
    // Use arithmetic math: v may exceed 32 bits (ms timestamps, E7 coords).
    while (v >= 0x80) {
      this.ensure(1);
      this.buf[this.len++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.ensure(1);
    this.buf[this.len++] = v;
  }

  /** Append a signed LEB128 integer via zig-zag mapping. */
  svarint(value: number): void {
    this.uvarint(zigzag(value));
  }

  /** The written bytes as a fresh, exactly-sized Uint8Array. */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /** Number of bytes written so far. */
  get length(): number {
    return this.len;
  }
}

/** A sequential reader over a byte buffer produced by `ByteWriter`. */
export class ByteReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  /** True while unread bytes remain. */
  get hasMore(): boolean {
    return this.pos < this.buf.length;
  }

  /** Current read offset (bytes consumed). */
  get offset(): number {
    return this.pos;
  }

  /** Read one raw byte. */
  byte(): number {
    if (this.pos >= this.buf.length) throw new RangeError("ByteReader: read past end");
    return this.buf[this.pos++];
  }

  /** Read an unsigned LEB128 integer. */
  uvarint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      if (this.pos >= this.buf.length) throw new RangeError("ByteReader: truncated uvarint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 0x80;
    }
  }

  /** Read a signed LEB128 integer (zig-zag decoded). */
  svarint(): number {
    return unzigzag(this.uvarint());
  }
}

/** Map a signed integer to an unsigned one so small magnitudes stay compact. */
export function zigzag(value: number): number {
  const v = Math.trunc(value);
  return v < 0 ? -v * 2 - 1 : v * 2;
}

/** Inverse of `zigzag`. */
export function unzigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}
