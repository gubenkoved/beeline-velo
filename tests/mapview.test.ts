import { describe, expect, it } from "vitest";

import type { RideView } from "../src/controller";
import {
  distToSegmentPx,
  distToTrackPx,
  nearestRides,
  ridesWithTracks,
  type PixelPoint,
  type ProjectedTrack,
} from "../src/mapview";
import { encodePolyline, type LatLon } from "../src/track";

/** Build a minimal RideView; only the fields the map cares about matter. */
function ride(over: Partial<RideView> = {}): RideView {
  return {
    key: "Sat Jun 13 2026 at 14:22",
    title: "Morning ride",
    location: "",
    distance: "10 km",
    duration: "30 mins",
    status: "uploaded",
    stats: {},
    track: "",
    track_src_points: 0,
    track_points: 0,
    track_km: 0,
    track_bytes: 0,
    month_key: "2026-06",
    month_label: "June 2026",
    uploaded_at: "",
    deleted: false,
    deleted_at: "",
    ...over,
  };
}

const line = (pts: LatLon[]): string => encodePolyline(pts);

describe("ridesWithTracks", () => {
  it("decodes rides that have a route and counts the rest as missing", () => {
    const rides = [
      ride({ key: "a", track: line([[52.37, 4.9], [52.38, 4.91]]) }),
      ride({ key: "b", track: "" }), // never downloaded
      ride({ key: "c", track: line([[51.0, 3.0], [51.01, 3.02], [51.02, 3.03]]) }),
    ];
    const { tracks, missing } = ridesWithTracks(rides);
    expect(tracks.map((t) => t.key)).toEqual(["a", "c"]);
    expect(missing).toBe(1);
    expect(tracks[0].points.length).toBe(2);
    expect(tracks[1].points.length).toBe(3);
  });

  it("ignores deleted rides entirely (not drawn, not counted as missing)", () => {
    const rides = [
      ride({ key: "a", track: "", deleted: true }),
      ride({ key: "b", track: line([[1, 2], [3, 4]]), deleted: true }),
      ride({ key: "c", track: "" }),
    ];
    const { tracks, missing } = ridesWithTracks(rides);
    expect(tracks).toEqual([]);
    expect(missing).toBe(1);
  });

  it("treats a single-point route as missing (nothing to draw)", () => {
    const { tracks, missing } = ridesWithTracks([ride({ key: "a", track: line([[52.37, 4.9]]) })]);
    expect(tracks).toEqual([]);
    expect(missing).toBe(1);
  });

  it("falls back to a default title when the ride has none", () => {
    const { tracks } = ridesWithTracks([ride({ key: "a", title: "", track: line([[1, 2], [3, 4]]) })]);
    expect(tracks[0].title).toBe("Ride");
  });
});

describe("distToSegmentPx", () => {
  const a: PixelPoint = { x: 0, y: 0 };
  const b: PixelPoint = { x: 10, y: 0 };

  it("is zero on the segment", () => {
    expect(distToSegmentPx({ x: 5, y: 0 }, a, b)).toBe(0);
  });

  it("is the perpendicular distance beside the segment", () => {
    expect(distToSegmentPx({ x: 5, y: 3 }, a, b)).toBeCloseTo(3);
  });

  it("clamps to the nearest endpoint past the ends", () => {
    expect(distToSegmentPx({ x: -4, y: 0 }, a, b)).toBeCloseTo(4);
    expect(distToSegmentPx({ x: 13, y: 4 }, a, b)).toBeCloseTo(5);
  });

  it("handles a degenerate (zero-length) segment", () => {
    expect(distToSegmentPx({ x: 3, y: 4 }, a, a)).toBeCloseTo(5);
  });
});

describe("distToTrackPx", () => {
  const pts: PixelPoint[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it("returns the closest segment distance across the whole polyline", () => {
    expect(distToTrackPx({ x: 11, y: 5 }, pts)).toBeCloseTo(1);
  });

  it("is infinite for an empty polyline", () => {
    expect(distToTrackPx({ x: 0, y: 0 }, [])).toBe(Infinity);
  });
});

describe("nearestRides", () => {
  // Two parallel tracks; they overlap (cross within threshold) around x≈5.
  const projected: ProjectedTrack[] = [
    { key: "ride-1", pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { key: "ride-2", pts: [{ x: 0, y: 2 }, { x: 10, y: 2 }] },
    { key: "ride-3", pts: [{ x: 0, y: 100 }, { x: 10, y: 100 }] },
  ];

  it("returns the single ride under the cursor", () => {
    // Tight threshold so only ride-1 (0px away) qualifies, not ride-2 (2px away).
    expect(nearestRides(projected, { x: 5, y: 0 }, 1.5)).toEqual(["ride-1"]);
  });

  it("lists every overlapping ride, nearest first", () => {
    // y=1 is 1px from ride-1 and 1px from ride-2 — tie, but ride-1 listed (stable).
    const hits = nearestRides(projected, { x: 5, y: 0.5 }, 6);
    expect(hits).toContain("ride-1");
    expect(hits).toContain("ride-2");
    expect(hits).not.toContain("ride-3");
    expect(hits[0]).toBe("ride-1"); // nearer (0.5px) than ride-2 (1.5px)
  });

  it("returns nothing when the cursor misses every track", () => {
    expect(nearestRides(projected, { x: 5, y: 50 }, 6)).toEqual([]);
  });
});
