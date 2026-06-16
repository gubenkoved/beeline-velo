import { describe, expect, it } from "vitest";

import { type BlobStore, memoryBlobBackend } from "../src/kv";
import type { CellDayWind } from "../src/weather";
import { cellDayKey } from "../src/weather";
import { decodeCellDay, encodeCellDay, WindCache } from "../src/windcache";

const sampleEntry = (dayISO = "2026-06-13", noData = false): CellDayWind =>
  noData
    ? {
        dataset: "era5",
        latIdx: 208,
        lonIdx: 52,
        cellLat: 52,
        cellLon: 13,
        gridKm: 25,
        dayISO,
        step: 0,
        hourly: {},
        noData: true,
      }
    : {
        dataset: "era5",
        latIdx: 208,
        lonIdx: 52,
        cellLat: 52.0123,
        cellLon: 13.0456,
        gridKm: 25,
        dayISO,
        step: 24,
        hourly: {
          wind_speed_10m: Array.from({ length: 24 }, (_, h) => 10 + h * 0.123),
          wind_direction_10m: Array.from({ length: 24 }, (_, h) => (h * 17) % 360),
          wind_gusts_10m: Array.from({ length: 24 }, (_, h) => 15 + h * 0.2),
        },
      };

describe("cell-day encoding", () => {
  it("round-trips at full precision (lossless)", async () => {
    const entry = sampleEntry();
    const decoded = await decodeCellDay(await encodeCellDay(entry));
    expect(decoded).not.toBeNull();
    expect(decoded!.cellLat).toBe(52.0123);
    expect(decoded!.hourly.wind_speed_10m).toEqual(entry.hourly.wind_speed_10m);
    expect(decoded!.hourly.wind_direction_10m).toEqual(entry.hourly.wind_direction_10m);
    expect(decoded!.v).toBe(1);
  });

  it("preserves the negative-cache sentinel", async () => {
    const decoded = await decodeCellDay(await encodeCellDay(sampleEntry("2026-06-13", true)));
    expect(decoded!.noData).toBe(true);
  });

  it("discards an entry written by an unknown future version", async () => {
    const future = new TextEncoder().encode(JSON.stringify({ v: 999, dataset: "era5" }));
    const { gzip } = await import("../src/gzip");
    expect(await decodeCellDay(await gzip(future))).toBeNull();
  });
});

describe("WindCache", () => {
  const key = (e: CellDayWind) => cellDayKey(e.dataset, e.latIdx, e.lonIdx, e.dayISO);

  it("stores and returns entries, tracking presence + size without reads", async () => {
    const map = new Map<string, Uint8Array>();
    const backend: BlobStore = memoryBlobBackend(map);
    const cache = await WindCache.load(backend);
    const a = sampleEntry("2026-06-13");
    const b = sampleEntry("2026-06-14");
    await cache.putMany([a, b]);
    expect(cache.has(key(a))).toBe(true);
    expect(cache.count).toBe(2);
    expect(cache.totalBytes()).toBeGreaterThan(0);
    const back = await cache.get(key(a));
    expect(back!.hourly.wind_speed_10m).toEqual(a.hourly.wind_speed_10m);
  });

  it("missingKeys returns only the true gaps (global reuse)", async () => {
    const cache = await WindCache.load(memoryBlobBackend());
    const a = sampleEntry("2026-06-13");
    await cache.putMany([a]);
    const want = [key(a), cellDayKey("era5", 999, 999, "2026-06-13")];
    expect(cache.missingKeys(want)).toEqual([want[1]]);
  });

  it("a second ride sharing a cached cell-day needs no fetch", async () => {
    const cache = await WindCache.load(memoryBlobBackend());
    await cache.putMany([sampleEntry("2026-06-13")]);
    // Ride B crosses the same cell on the same day → already present.
    const needed = [cellDayKey("era5", 208, 52, "2026-06-13")];
    expect(cache.missingKeys(needed)).toEqual([]);
  });

  it("persists its index across reloads (shared backend)", async () => {
    const map = new Map<string, Uint8Array>();
    const first = await WindCache.load(memoryBlobBackend(map));
    await first.putMany([sampleEntry("2026-06-13")]);
    const second = await WindCache.load(memoryBlobBackend(map));
    expect(second.count).toBe(1);
    expect(second.has(cellDayKey("era5", 208, 52, "2026-06-13"))).toBe(true);
  });

  it("flush clears the wind cache only", async () => {
    const map = new Map<string, Uint8Array>();
    const cache = await WindCache.load(memoryBlobBackend(map));
    await cache.putMany([sampleEntry("2026-06-13"), sampleEntry("2026-06-14")]);
    await cache.flush();
    expect(cache.count).toBe(0);
    expect(cache.totalBytes()).toBe(0);
    expect(map.size).toBe(0);
  });
});
