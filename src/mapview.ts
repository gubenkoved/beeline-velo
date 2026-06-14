/**
 * "Map" view logic — the all-rides heatmap.
 *
 * Pure, DOM-free helpers for the map tab that draws every downloaded ride track
 * on one Leaflet map as overlapping translucent lines (a personal heatmap: the
 * more you ride a stretch, the more lines stack and the brighter it gets).
 *
 * The geometry here is deliberately UI-agnostic: callers project each ride's
 * lat/lon track into screen pixels (via Leaflet's `latLngToContainerPoint`) and
 * hand the pixel polylines to `nearestRides()` for hit-testing under the cursor.
 * Keeping the math out of `main.ts` lets us unit-test the hover/overlap logic
 * without a browser or a real map.
 */

import type { RideView } from "./controller";
import { rideDatetime } from "./parsing";
import { decodePolyline, type LatLon } from "./track";

/** A ride reduced to just what the map needs: an id, a label and its route. */
export interface RideTrack {
  key: string;
  title: string;
  points: LatLon[]; // [lat, lon] pairs decoded from the stored polyline
}

/** Result of selecting the drawable rides out of the full ride list. */
export interface TrackSelection {
  /** Rides that have a usable (>= 2 point) route to draw. */
  tracks: RideTrack[];
  /** How many non-deleted rides have no downloaded track yet. */
  missing: number;
}

/** A 2-D screen point, in container pixels. */
export interface PixelPoint {
  x: number;
  y: number;
}

/** A ride's route projected into container pixels, ready for hit-testing. */
export interface ProjectedTrack {
  key: string;
  pts: PixelPoint[];
}

/**
 * Split the ride list into drawable tracks (decoded, >= 2 points) and a count of
 * rides still missing a route. Deleted rides are ignored entirely — they can't be
 * re-downloaded and would only inflate the "missing" hint. Undecodable polylines
 * are skipped defensively rather than throwing.
 */
export function ridesWithTracks(rides: RideView[]): TrackSelection {
  const tracks: RideTrack[] = [];
  let missing = 0;
  for (const r of rides) {
    if (r.deleted) continue;
    if (!r.track) {
      missing++;
      continue;
    }
    let points: LatLon[];
    try {
      points = decodePolyline(r.track);
    } catch {
      missing++;
      continue;
    }
    if (points.length < 2) {
      missing++;
      continue;
    }
    tracks.push({ key: r.key, title: r.title || "Ride", points });
  }
  return { tracks, missing };
}

/** An inclusive timestamp span (ms since epoch) covering a set of rides. */
export interface DateRange {
  minMs: number;
  maxMs: number;
}

/**
 * Day-snapped timestamp span covering every dated, non-deleted ride: `minMs` is
 * the start (00:00 local) of the earliest ride's day and `maxMs` the end
 * (23:59:59.999 local) of the latest, so the whole boundary days are included.
 * Returns null when no ride has a parseable date — there's nothing to range over.
 */
export function dateRange(rides: RideView[]): DateRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rides) {
    if (r.deleted) continue;
    const dt = rideDatetime(r.key);
    if (!dt) continue;
    const t = dt.getTime();
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min === Infinity) return null;
  const lo = new Date(min);
  lo.setHours(0, 0, 0, 0);
  const hi = new Date(max);
  hi.setHours(23, 59, 59, 999);
  return { minMs: lo.getTime(), maxMs: hi.getTime() };
}

/**
 * Keep only rides whose date falls within `[fromMs, toMs]` (inclusive). Rides
 * whose key has no parseable date are ALWAYS kept: they can't be placed on the
 * timeline, and hiding them would silently drop data the user can't get back via
 * the slider. Deleted rides pass through untouched (downstream `ridesWithTracks`
 * is what drops them), so callers can reuse this for both the map and side panel.
 */
export function filterRidesByRange(rides: RideView[], fromMs: number, toMs: number): RideView[] {
  return rides.filter((r) => {
    const dt = rideDatetime(r.key);
    if (!dt) return true;
    const t = dt.getTime();
    return t >= fromMs && t <= toMs;
  });
}

/** Shortest distance from point `p` to the segment `a`–`b`, in pixels. */
export function distToSegmentPx(p: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const tc = Math.max(0, Math.min(1, t));
  const cx = a.x + tc * dx;
  const cy = a.y + tc * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Shortest distance from `cursor` to any segment of a projected polyline. */
export function distToTrackPx(cursor: PixelPoint, pts: PixelPoint[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(cursor.x - pts[0].x, cursor.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegmentPx(cursor, pts[i - 1], pts[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Keys of every ride whose projected route passes within `thresholdPx` of the
 * cursor, nearest first. An empty result means the cursor isn't over any track;
 * multiple results mean several rides overlap there (which the caller lists in
 * the side panel so the user can tell them apart).
 */
export function nearestRides(projected: ProjectedTrack[], cursor: PixelPoint, thresholdPx: number): string[] {
  const hits: Array<{ key: string; dist: number }> = [];
  for (const track of projected) {
    const d = distToTrackPx(cursor, track.pts);
    if (d <= thresholdPx) hits.push({ key: track.key, dist: d });
  }
  hits.sort((a, b) => a.dist - b.dist);
  return hits.map((h) => h.key);
}
