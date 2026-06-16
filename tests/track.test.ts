import { describe, expect, it } from "vitest";

import {
  decodePolyline,
  encodePolyline,
  extractFullTrack,
  extractTrack,
  fullTrackSpeedsKmh,
  fullTrackSummary,
  gpxToRoughTrack,
  hasElevation,
  hasTimes,
  type LatLon,
  movingAverage,
  simplify,
  trackLengthKm,
} from "../src/track";

const GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
  <trkpt lat="52.370000" lon="4.900000"></trkpt>
  <trkpt lat="52.371000" lon="4.901000"></trkpt>
  <trkpt lat="52.372000" lon="4.902500"></trkpt>
  <trkpt lat="52.373000" lon="4.904000"></trkpt>
</trkseg></trk></gpx>`;

describe("extractTrack", () => {
  it("reads trkpt lat/lon pairs", () => {
    const pts = extractTrack(GPX);
    expect(pts.length).toBe(4);
    expect(pts[0]).toEqual([52.37, 4.9]);
  });

  it("falls back to rtept when there is no track", () => {
    const rte = `<gpx><rte><rtept lat="1" lon="2"></rtept><rtept lat="3" lon="4"></rtept></rte></gpx>`;
    expect(extractTrack(rte)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns nothing for a GPX without points", () => {
    expect(extractTrack("<gpx></gpx>")).toEqual([]);
  });
});

const FULL_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="Beeline"><trk><trkseg>
  <trkpt lat="52.000000" lon="5.000000"><ele>10</ele><time>2026-06-13T12:00:00.000Z</time></trkpt>
  <trkpt lat="52.001000" lon="5.000000"><ele>12.5</ele><time>2026-06-13T12:00:10.000Z</time></trkpt>
  <trkpt lat="52.002000" lon="5.000000"><ele>15</ele><time>2026-06-13T12:00:20.000Z</time></trkpt>
</trkseg></trk></gpx>`;

describe("extractFullTrack", () => {
  it("reads lat/lon plus per-point elevation and time", () => {
    const ft = extractFullTrack(FULL_GPX);
    expect(ft.points).toEqual([
      [52, 5],
      [52.001, 5],
      [52.002, 5],
    ]);
    expect(ft.eles).toEqual([10, 12.5, 15]);
    expect(ft.times[0]).toBe(Date.parse("2026-06-13T12:00:00.000Z"));
    expect(ft.times[2]).toBe(Date.parse("2026-06-13T12:00:20.000Z"));
    expect(hasElevation(ft)).toBe(true);
    expect(hasTimes(ft)).toBe(true);
  });

  it("tolerates points missing ele/time (records null for them)", () => {
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="1" lon="2"></trkpt>
      <trkpt lat="3" lon="4"><ele>7</ele></trkpt>
    </trkseg></trk></gpx>`;
    const ft = extractFullTrack(gpx);
    expect(ft.points).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(ft.eles).toEqual([null, 7]);
    expect(ft.times).toEqual([null, null]);
    expect(hasElevation(ft)).toBe(false); // only one real elevation
    expect(hasTimes(ft)).toBe(false);
  });
});

describe("fullTrackSpeedsKmh", () => {
  it("derives per-point speed from times + geometry", () => {
    const ft = extractFullTrack(FULL_GPX);
    const speeds = fullTrackSpeedsKmh(ft);
    expect(speeds).toHaveLength(3);
    // ~111.2 m over 10 s ≈ 40 km/h between each consecutive pair.
    expect(speeds[0]).toBeGreaterThan(38);
    expect(speeds[0]).toBeLessThan(42);
    // Final point repeats the previous speed (no trailing gap).
    expect(speeds[2]).toBeCloseTo(speeds[1] as number, 6);
  });

  it("returns nulls where timestamps are missing", () => {
    const ft = extractFullTrack(
      `<gpx><trk><trkseg>
        <trkpt lat="1" lon="2"></trkpt>
        <trkpt lat="1.001" lon="2"></trkpt>
      </trkseg></trk></gpx>`,
    );
    expect(fullTrackSpeedsKmh(ft)).toEqual([null, null]);
  });
});

describe("fullTrackSummary", () => {
  it("derives the full-track-only headline stats", () => {
    const ft = extractFullTrack(FULL_GPX);
    const s = fullTrackSummary(ft);
    expect(s.points).toBe(3);
    expect(s.distanceKm).toBeGreaterThan(0);
    // Monotonic climb 10→12.5→15 → +5 m gain, 0 loss.
    expect(s.gainM).toBeCloseTo(5, 6);
    expect(s.lossM).toBeCloseTo(0, 6);
    // 20 s recording span.
    expect(s.recordedSec).toBeCloseTo(20, 6);
    expect(s.maxKmh).toBeGreaterThan(0);
    expect(s.avgKmh).toBeGreaterThan(0);
  });

  it("leaves elevation/time fields null when the track lacks them", () => {
    const ft = extractFullTrack(
      `<gpx><trk><trkseg>
        <trkpt lat="1" lon="2"></trkpt>
        <trkpt lat="1.001" lon="2"></trkpt>
      </trkseg></trk></gpx>`,
    );
    const s = fullTrackSummary(ft);
    expect(s.points).toBe(2);
    expect(s.gainM).toBeNull();
    expect(s.lossM).toBeNull();
    expect(s.recordedSec).toBeNull();
    expect(s.maxKmh).toBeNull();
    expect(s.avgKmh).toBeNull();
  });
});

describe("movingAverage", () => {
  it("smooths over a window and skips null gaps", () => {
    expect(movingAverage([1, 2, 3, 4, 5], 1)).toEqual([1.5, 2, 3, 4, 4.5]);
    expect(movingAverage([2, null, 4], 1)).toEqual([2, 3, 4]);
    expect(movingAverage([null, null], 1)).toEqual([null, null]);
  });
});

describe("simplify", () => {
  it("reduces the point count to the cap", () => {
    const pts: LatLon[] = [];
    for (let i = 0; i < 500; i++) pts.push([52 + i * 0.001, 4 + Math.sin(i / 10) * 0.01]);
    const out = simplify(pts, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.length).toBeGreaterThan(1);
    // endpoints are preserved
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it("keeps a track already under the cap unchanged", () => {
    const pts: LatLon[] = [
      [1, 1],
      [2, 2],
    ];
    expect(simplify(pts, 100)).toEqual(pts);
  });
});

describe("encode/decode polyline", () => {
  it("round-trips within precision tolerance", () => {
    const pts: LatLon[] = [
      [52.37, 4.9],
      [52.371, 4.9011],
      [52.3725, 4.9026],
    ];
    const decoded = decodePolyline(encodePolyline(pts));
    expect(decoded.length).toBe(pts.length);
    for (let i = 0; i < pts.length; i++) {
      expect(decoded[i][0]).toBeCloseTo(pts[i][0], 4);
      expect(decoded[i][1]).toBeCloseTo(pts[i][1], 4);
    }
  });
});

describe("trackLengthKm", () => {
  it("sums consecutive great-circle hops", () => {
    // ~1.11 km per 0.01° of latitude.
    const km = trackLengthKm([
      [52.0, 4.0],
      [52.01, 4.0],
      [52.02, 4.0],
    ]);
    expect(km).toBeGreaterThan(2.1);
    expect(km).toBeLessThan(2.3);
  });

  it("is zero for fewer than two points", () => {
    expect(trackLengthKm([])).toBe(0);
    expect(trackLengthKm([[1, 1]])).toBe(0);
  });
});

describe("gpxToRoughTrack", () => {
  it("produces a compact, decodable polyline with capture metadata", () => {
    const bytes = new TextEncoder().encode(GPX);
    const rough = gpxToRoughTrack(bytes, 10);
    expect(rough.polyline.length).toBeGreaterThan(0);
    expect(rough.srcPoints).toBe(4);
    expect(rough.keptPoints).toBeGreaterThanOrEqual(2);
    expect(rough.km).toBeGreaterThan(0);
    const decoded = decodePolyline(rough.polyline);
    expect(decoded.length).toBe(rough.keptPoints);
    expect(decoded[0][0]).toBeCloseTo(52.37, 4);
  });

  it("keeps more points at a higher density", () => {
    const pts: LatLon[] = [];
    for (let i = 0; i < 400; i++) pts.push([52 + i * 0.001, 4 + Math.sin(i / 8) * 0.01]);
    const gpx =
      `<gpx><trk><trkseg>` +
      pts.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join("") +
      `</trkseg></trk></gpx>`;
    const bytes = new TextEncoder().encode(gpx);
    const coarse = gpxToRoughTrack(bytes, 2);
    const fine = gpxToRoughTrack(bytes, 20);
    expect(fine.keptPoints).toBeGreaterThanOrEqual(coarse.keptPoints);
    // Endpoints are always preserved.
    const decoded = decodePolyline(coarse.polyline);
    expect(decoded[0][0]).toBeCloseTo(pts[0][0], 4);
    expect(decoded[decoded.length - 1][0]).toBeCloseTo(pts[pts.length - 1][0], 4);
  });

  it("returns an empty polyline when there is no usable track", () => {
    const rough = gpxToRoughTrack(new TextEncoder().encode("<gpx></gpx>"), 10);
    expect(rough.polyline).toBe("");
    expect(rough.keptPoints).toBe(0);
    expect(rough.km).toBe(0);
  });
});
