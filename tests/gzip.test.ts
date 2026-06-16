import { describe, expect, it } from "vitest";

import { gunzip, gzip } from "../src/gzip";

describe("gzip / gunzip", () => {
  it("round-trips text through gzip → gunzip", async () => {
    const original = new TextEncoder().encode("<gpx>…lots of points…</gpx>".repeat(50));
    const gz = await gzip(original);
    const back = await gunzip(gz);
    expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(original));
  });

  it("emits a real gzip stream (magic header 1f 8b) that shrinks compressible input", async () => {
    const original = new TextEncoder().encode("A".repeat(10_000));
    const gz = await gzip(original);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(gz.length).toBeLessThan(original.length);
  });

  it("gunzip passes through bytes that aren't gzipped", async () => {
    const plain = new TextEncoder().encode("<gpx/>");
    expect(await gunzip(plain)).toEqual(plain);
  });

  it("round-trips binary bytes (0x00..0xff)", async () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const back = await gunzip(await gzip(original));
    expect(back).toEqual(original);
  });
});
