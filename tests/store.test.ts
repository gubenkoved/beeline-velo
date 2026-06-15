import { beforeEach, describe, expect, it } from "vitest";

import { type KeyValueStore, memoryBackend } from "../src/kv";
import { DEFAULT_TRACK_POINTS_PER_KM, STORAGE_KEY, Store } from "../src/store";

describe("Store", () => {
  let map: Map<string, string>;
  let backend: KeyValueStore;
  beforeEach(() => {
    map = new Map<string, string>();
    backend = memoryBackend(map);
  });

  it("upserts and persists, then reloads", async () => {
    const s = await Store.load(backend);
    s.upsert("Sat Jun 13 2026 at 14:22", {
      title: "Afternoon ride",
      distance_km: 22.6,
      elapsed_sec: 5872,
    });
    s.save();
    await s.flush();

    const reloaded = await Store.load(backend);
    const rec = reloaded.rides.get("Sat Jun 13 2026 at 14:22")!;
    expect(rec.title).toBe("Afternoon ride");
    expect(rec.distance_km).toBeCloseTo(22.6);
    expect(rec.elapsed_sec).toBe(5872);
    expect(rec.strava_status).toBe("unknown");
  });

  it("stamps uploaded_at only on the transition to uploaded", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { strava_status: "pending" });
    expect(s.rides.get("k")!.uploaded_at).toBe("");
    s.upsert("k", { strava_status: "uploaded" });
    const at = s.rides.get("k")!.uploaded_at;
    expect(at).not.toBe("");
    s.upsert("k", { strava_status: "uploaded" }); // no second stamp
    expect(s.rides.get("k")!.uploaded_at).toBe(at);
  });

  it("scrubs known bad titles on load", async () => {
    map.set(
      STORAGE_KEY,
      JSON.stringify({ updated_at: "x", rides: { k: { key: "k", title: "Heatmap" } } }),
    );
    expect((await Store.load(backend)).rides.get("k")!.title).toBe("");
  });

  it("scrubs stat-shaped titles persisted by an earlier parsing bug", async () => {
    // The old detail parser could store a stat value as the title when the heading
    // scrolled off-screen during a Check (e.g. "20,0km/h"). Loading must clear it
    // so a re-scan/check reseeds a real title.
    map.set(
      STORAGE_KEY,
      JSON.stringify({
        updated_at: "x",
        rides: { k: { key: "k", title: "20,0km/h", title_base: "209m" } },
      }),
    );
    const rec = (await Store.load(backend)).rides.get("k")!;
    expect(rec.title).toBe("");
    expect(rec.title_base).toBe("");
  });

  it("round-trips the source identity (device_model)", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { device_model: "Beeline (rider@example.com)" });
    s.save();
    await s.flush();

    const reloaded = await Store.load(backend);
    const rec = reloaded.rides.get("k")!;
    expect(rec.device_model).toBe("Beeline (rider@example.com)");
  });

  it("defaults the device fields to empty for legacy records without them", async () => {
    map.set(
      STORAGE_KEY,
      JSON.stringify({ updated_at: "x", rides: { k: { key: "k", title: "Ride" } } }),
    );
    const rec = (await Store.load(backend)).rides.get("k")!;
    expect(rec.device_model).toBe("");
  });

  it("seeds the display title from the scan name, then keeps the fuller checked title", async () => {
    const s = await Store.load(backend);
    // Scan writes only the short list name.
    s.upsert("k", { title_base: "Morning ride" });
    expect(s.rides.get("k")!.title_base).toBe("Morning ride");
    expect(s.rides.get("k")!.title).toBe("Morning ride"); // seeded so it renders before check

    // Check writes the fuller heading; the short name is preserved separately.
    s.upsert("k", { title: "Morning ride, Amstelveen" });
    expect(s.rides.get("k")!.title).toBe("Morning ride, Amstelveen");
    expect(s.rides.get("k")!.title_base).toBe("Morning ride");

    // A later scan must not clobber the fuller checked title.
    s.upsert("k", { title_base: "Morning ride" });
    expect(s.rides.get("k")!.title).toBe("Morning ride, Amstelveen");
  });

  it("scrubs known bad title_base on load", async () => {
    map.set(
      STORAGE_KEY,
      JSON.stringify({ updated_at: "x", rides: { k: { key: "k", title_base: "Journeys" } } }),
    );
    expect((await Store.load(backend)).rides.get("k")!.title_base).toBe("");
  });

  it("export shape matches the Python rides.json (updated_at + rides map)", async () => {
    const s = await Store.load(backend);
    s.upsert("Sat Jun 13 2026 at 14:22", {
      title: "Afternoon ride",
      strava_status: "uploaded",
    });
    const parsed = JSON.parse(s.exportJson());
    expect(typeof parsed.updated_at).toBe("string");
    expect(Object.keys(parsed.rides)).toContain("Sat Jun 13 2026 at 14:22");
    const rec = parsed.rides["Sat Jun 13 2026 at 14:22"];
    expect(rec).toMatchObject({
      key: "Sat Jun 13 2026 at 14:22",
      title: "Afternoon ride",
      strava_status: "uploaded",
    });
    expect(rec).toHaveProperty("uploaded_at");
    expect(rec).toHaveProperty("last_seen");
  });

  it("migrates a legacy string-schema rides.json on import (and drops the strings)", async () => {
    const s = await Store.load(backend);
    s.upsert("existing", { title: "Old" });
    // The pre-normalization shape (also produced by the old Python tool): localized
    // distance/duration strings plus a `stats` label→string map.
    const legacy = JSON.stringify({
      updated_at: "2026-06-13T20:30:45+00:00",
      rides: {
        "Sat Jun 13 2026 at 14:22": {
          key: "Sat Jun 13 2026 at 14:22",
          title: "Afternoon ride",
          distance: "22.6km",
          duration: "1:37:52",
          strava_status: "uploaded",
          stats: {
            Distance: "22.6km",
            "Average speed": "20,0km/h",
            "Moving time": "1:07:42",
            "Elapsed time": "1:37:52",
            "Elevation gain": "25m",
          },
          last_seen: "2026-06-13T20:30:45+00:00",
          uploaded_at: "2026-06-13T19:15:22+00:00",
        },
      },
    });
    const n = s.importJson(legacy);
    expect(n).toBe(1);
    const rec = s.rides.get("Sat Jun 13 2026 at 14:22")!;
    expect(rec.strava_status).toBe("uploaded");
    // Migrated to numbers (comma-decimal "20,0km/h" → 20.0, not 200).
    expect(rec.distance_km).toBeCloseTo(22.6);
    expect(rec.avg_speed_kmh).toBeCloseTo(20.0);
    expect(rec.moving_sec).toBe(1 * 3600 + 7 * 60 + 42);
    expect(rec.elapsed_sec).toBe(1 * 3600 + 37 * 60 + 52);
    expect(rec.elevation_gain_m).toBeCloseTo(25);
    // …and the legacy string fields are gone from the record.
    const raw = rec as unknown as Record<string, unknown>;
    expect(raw.distance).toBeUndefined();
    expect(raw.duration).toBeUndefined();
    expect(raw.stats).toBeUndefined();
    expect(s.rides.get("existing")).toBeDefined();
  });

  it("defaults, clamps, and round-trips the track-detail setting", async () => {
    const s = await Store.load(backend);
    expect(s.settings.trackPointsPerKm).toBe(DEFAULT_TRACK_POINTS_PER_KM);
    expect(s.setTrackPointsPerKm(0)).toBe(1); // clamped up to the minimum
    expect(s.setTrackPointsPerKm(9999)).toBe(100); // clamped down to the maximum
    s.setTrackPointsPerKm(25);
    await s.flush();
    expect((await Store.load(backend)).settings.trackPointsPerKm).toBe(25);
  });

  it("persists a per-ride rough track", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { track: "abc123" });
    s.save();
    await s.flush();
    expect((await Store.load(backend)).rides.get("k")!.track).toBe("abc123");
  });

  it("persists per-ride GPX capture metadata", async () => {
    const s = await Store.load(backend);
    s.upsert("k", {
      track: "abc123",
      track_src_points: 1432,
      track_points: 87,
      track_km: 12.3,
      track_bytes: 24576,
    });
    s.save();
    await s.flush();
    const rec = (await Store.load(backend)).rides.get("k")!;
    expect(rec.track_src_points).toBe(1432);
    expect(rec.track_points).toBe(87);
    expect(rec.track_km).toBe(12.3);
    expect(rec.track_bytes).toBe(24576);
  });

  it("clear() wipes rides, restores default settings, and removes the stored blob", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { title: "Ride" });
    s.setTrackPointsPerKm(30);
    s.save();
    await s.flush();
    expect(map.get(STORAGE_KEY)).not.toBeUndefined();

    s.clear();

    expect(s.rides.size).toBe(0);
    expect(s.settings.trackPointsPerKm).toBe(DEFAULT_TRACK_POINTS_PER_KM);
    expect(map.has(STORAGE_KEY)).toBe(false);
    // A fresh load now starts empty.
    expect((await Store.load(backend)).rides.size).toBe(0);
  });

  it("byteSize tracks the persisted payload: grows with rides, shrinks on clear", async () => {
    const s = await Store.load(backend);
    const empty = s.byteSize();
    expect(empty).toBeGreaterThan(0); // the serialized envelope is never zero bytes

    s.upsert("Sat Jun 13 2026 at 14:22", { title: "Afternoon ride", distance_km: 22.6 });
    s.save();
    await s.flush();
    const withRide = s.byteSize();
    expect(withRide).toBeGreaterThan(empty);

    // Importing more rides keeps the size in step without an explicit save/flush.
    s.importJson(
      JSON.stringify({ updated_at: "x", rides: { k2: { key: "k2", title: "Another" } } }),
    );
    expect(s.byteSize()).toBeGreaterThan(withRide);

    s.clear();
    expect(s.byteSize()).toBe(empty);
  });
});
