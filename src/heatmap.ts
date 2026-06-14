/**
 * Frequency-heatmap geometry — pure, DOM-free helpers for the "Stats" view map.
 *
 * The all-rides Map view draws each route as a translucent line, so frequency
 * only reads as faint stacking. To show *how often* a stretch is ridden far more
 * clearly, we resample every track to evenly-spaced points and feed those to a
 * heat layer: a corridor ridden daily accumulates many more points per metre than
 * a one-off, so it glows while rare routes stay dim — independent of how densely
 * the original polyline happened to be sampled.
 *
 * Like the rest of the map code this is shape-only (no timestamps/elevation); it
 * just turns line geometry into weighted points the renderer can sum.
 */

import type { RideTrack } from "./mapview";
import type { LatLon } from "./track";

/** A weighted heat sample: [lat, lon, intensity]. */
export type HeatPoint = [number, number, number];

/** Great-circle distance between two lat/lon points, in metres (haversine). */
function haversineM(a: LatLon, b: LatLon): number {
  const R = 6_371_000; // mean Earth radius (m)
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const lat1 = a[0] * toRad;
  const lat2 = b[0] * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Resample a polyline to points roughly `spacingM` metres apart, so density is
 * proportional to distance rather than to the original vertex count. The first
 * and last vertices are always kept; long segments get evenly interpolated
 * in-between points. Tracks with fewer than two points are returned unchanged.
 */
export function densifyTrack(points: LatLon[], spacingM: number): LatLon[] {
  if (points.length < 2 || spacingM <= 0) return points.slice();
  const out: LatLon[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = haversineM(a, b);
    const steps = Math.max(1, Math.floor(dist / spacingM));
    // Emit interior points (j = 1..steps-1) then the segment end at j = steps.
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * Flatten every ride track into evenly-spaced, weighted heat points. Each sample
 * carries the same `weight`, so the renderer's per-area sum reflects how many
 * passes (and thus how frequently) a stretch was ridden.
 */
export function buildHeatPoints(
  tracks: ReadonlyArray<RideTrack>,
  spacingM = 30,
  weight = 1,
): HeatPoint[] {
  const out: HeatPoint[] = [];
  for (const t of tracks) {
    for (const [lat, lon] of densifyTrack(t.points, spacingM)) {
      out.push([lat, lon, weight]);
    }
  }
  return out;
}
