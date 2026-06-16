import { beforeEach, describe, expect, it } from "vitest";

import { GpxCache } from "../src/gpxcache";
import { type BlobStore, memoryBlobBackend } from "../src/kv";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const GPX_A = `<gpx><trk><name>A</name>${"<trkpt/>".repeat(200)}</trk></gpx>`;
const GPX_B = `<gpx><trk><name>B</name>${"<trkpt/>".repeat(300)}</trk></gpx>`;

describe("GpxCache", () => {
  let map: Map<string, Uint8Array>;
  let backend: BlobStore;
  beforeEach(() => {
    map = new Map<string, Uint8Array>();
    backend = memoryBlobBackend(map);
  });

  it("stores and returns the original bytes (round-trip through gzip)", async () => {
    const cache = await GpxCache.load(backend, "beeline");
    await cache.put("ride-1", bytes(GPX_A));
    const back = await cache.get("ride-1");
    expect(back).not.toBeNull();
    expect(text(back!)).toBe(GPX_A);
  });

  it("stores the payload compressed on disk (smaller than the raw GPX)", async () => {
    const cache = await GpxCache.load(backend, "beeline");
    const raw = bytes(GPX_A);
    await cache.put("ride-1", raw);
    const stored = map.get("beeline::ride::ride-1")!;
    expect(stored.length).toBeLessThan(raw.length);
  });

  it("tracks presence, keys, count and total size without reading payloads", async () => {
    const cache = await GpxCache.load(backend, "beeline");
    await cache.put("ride-1", bytes(GPX_A));
    await cache.put("ride-2", bytes(GPX_B));
    expect(cache.has("ride-1")).toBe(true);
    expect(cache.has("missing")).toBe(false);
    expect(cache.cachedKeys()).toEqual(new Set(["ride-1", "ride-2"]));
    expect(cache.count).toBe(2);
    const storedTotal =
      map.get("beeline::ride::ride-1")!.length + map.get("beeline::ride::ride-2")!.length;
    expect(cache.totalBytes()).toBe(storedTotal);
  });

  it("get returns null for an uncached ride", async () => {
    const cache = await GpxCache.load(backend, "beeline");
    expect(await cache.get("nope")).toBeNull();
  });

  it("delete drops one ride only", async () => {
    const cache = await GpxCache.load(backend, "beeline");
    await cache.put("ride-1", bytes(GPX_A));
    await cache.put("ride-2", bytes(GPX_B));
    await cache.delete("ride-1");
    expect(cache.has("ride-1")).toBe(false);
    expect(cache.has("ride-2")).toBe(true);
    expect(await cache.get("ride-1")).toBeNull();
    expect(map.has("beeline::ride::ride-1")).toBe(false);
  });

  it("clear empties the cache (payloads + index) but only for its prefix", async () => {
    const beeline = await GpxCache.load(backend, "beeline");
    const demo = await GpxCache.load(backend, "demo");
    await beeline.put("ride-1", bytes(GPX_A));
    await demo.put("ride-1", bytes(GPX_B));

    await beeline.clear();

    expect(beeline.count).toBe(0);
    expect(beeline.totalBytes()).toBe(0);
    expect(map.has("beeline::ride::ride-1")).toBe(false);
    expect(map.has("beeline::__index")).toBe(false);
    // The demo profile's cache is untouched.
    expect(demo.has("ride-1")).toBe(true);
    expect(map.has("demo::ride::ride-1")).toBe(true);
  });

  it("isolates caches by prefix (no cross-profile reads)", async () => {
    const beeline = await GpxCache.load(backend, "beeline");
    const demo = await GpxCache.load(backend, "demo");
    await beeline.put("ride-1", bytes(GPX_A));
    expect(demo.has("ride-1")).toBe(false);
    expect(await demo.get("ride-1")).toBeNull();
  });

  it("survives a reload: a fresh cache over the same backend sees prior entries", async () => {
    const first = await GpxCache.load(backend, "beeline");
    await first.put("ride-1", bytes(GPX_A));

    const reloaded = await GpxCache.load(backend, "beeline");
    expect(reloaded.has("ride-1")).toBe(true);
    expect(reloaded.count).toBe(1);
    expect(reloaded.totalBytes()).toBe(first.totalBytes());
    expect(text((await reloaded.get("ride-1"))!)).toBe(GPX_A);
  });
});
