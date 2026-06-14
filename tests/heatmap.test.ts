import { describe, expect, it } from "vitest";

import { buildHeatPoints, densifyTrack, type HeatPoint } from "../src/heatmap";
import type { RideTrack } from "../src/mapview";
import type { LatLon } from "../src/track";

describe("densifyTrack", () => {
  it("keeps the original endpoints", () => {
    const pts: LatLon[] = [
      [52.0, 4.0],
      [52.01, 4.0],
    ];
    const dense = densifyTrack(pts, 50);
    expect(dense[0]).toEqual([52.0, 4.0]);
    expect(dense[dense.length - 1]).toEqual([52.01, 4.0]);
  });

  it("interpolates points roughly spacingM apart along a segment", () => {
    // ~1.11 km north (0.01° latitude). At 100 m spacing that's ~11 steps.
    const pts: LatLon[] = [
      [52.0, 4.0],
      [52.01, 4.0],
    ];
    const dense = densifyTrack(pts, 100);
    expect(dense.length).toBeGreaterThanOrEqual(10);
    expect(dense.length).toBeLessThanOrEqual(13);
    // Points should be monotonically increasing in latitude (evenly spread).
    for (let i = 1; i < dense.length; i++) {
      expect(dense[i][0]).toBeGreaterThan(dense[i - 1][0]);
    }
  });

  it("returns tracks shorter than two points unchanged", () => {
    expect(densifyTrack([], 50)).toEqual([]);
    expect(densifyTrack([[1, 2]], 50)).toEqual([[1, 2]]);
  });

  it("does not blow up on a zero/negative spacing", () => {
    const pts: LatLon[] = [
      [0, 0],
      [0, 1],
    ];
    expect(densifyTrack(pts, 0)).toEqual(pts);
  });
});

describe("buildHeatPoints", () => {
  const track = (key: string, points: LatLon[]): RideTrack => ({ key, title: key, points });

  it("emits weighted [lat, lon, weight] samples for every track", () => {
    const tracks = [track("a", [[52.0, 4.0], [52.005, 4.0]])];
    const pts = buildHeatPoints(tracks, 100, 1);
    expect(pts.length).toBeGreaterThan(1);
    for (const p of pts as HeatPoint[]) {
      expect(p).toHaveLength(3);
      expect(p[2]).toBe(1);
    }
  });

  it("accumulates more samples where two rides overlap the same corridor", () => {
    const corridor: LatLon[] = [
      [52.0, 4.0],
      [52.02, 4.0],
    ];
    const elsewhere: LatLon[] = [
      [48.0, 2.0],
      [48.001, 2.0],
    ];
    const onceRidden = buildHeatPoints([track("a", corridor), track("b", elsewhere)], 50);
    const twiceRidden = buildHeatPoints([track("a", corridor), track("b", corridor)], 50);
    // Two passes over the same corridor yield strictly more samples there, which
    // is what makes a frequently-ridden stretch glow hotter than a one-off.
    const near = (p: HeatPoint) => Math.abs(p[0] - 52.01) < 0.02 && Math.abs(p[1] - 4.0) < 0.01;
    const onceCount = (onceRidden as HeatPoint[]).filter(near).length;
    const twiceCount = (twiceRidden as HeatPoint[]).filter(near).length;
    expect(twiceCount).toBeGreaterThan(onceCount);
  });

  it("returns nothing for an empty track list", () => {
    expect(buildHeatPoints([])).toEqual([]);
  });
});
