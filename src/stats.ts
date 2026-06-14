/**
 * Lifetime ride analytics — pure, DOM-free aggregation for the "Stats" view.
 *
 * Everything here is computed from the cheap scalar fields we already parse off
 * the phone (distance, moving time, elevation) plus the ride datetime in the key.
 * There is deliberately no track/GPS work: totals and records only need the
 * per-ride summary numbers, which keeps this fast and trivially unit-testable.
 *
 * "Records" are distance-based, matching how riders think about a big effort:
 *   - biggest single ride, and
 *   - the best single day / week / month by total distance ridden.
 */

import { bucketRide, parseDurationSec, parseKm, parseMeters } from "./parsing";

// Re-export the canonical locale-aware parsers (defined once in ./parsing) so
// existing stats-focused tests and callers can keep importing them from here.
export { parseKm, parseLocaleNumber, parseMeters } from "./parsing";


/** The slice of a ride record this module needs (a structural subset of RideView). */
export interface StatsRide {
  key: string;
  distance: string;
  stats: Record<string, string>;
  track_km: number;
  deleted: boolean;
}

/** A single best-period record (e.g. the highest-distance week). */
export interface PeriodRecord {
  /** Human label of the winning bucket, e.g. "Week of Jun 8, 2026". */
  label: string;
  /** Total distance ridden in that bucket, in kilometres. */
  km: number;
  /** How many rides fell in that bucket. */
  count: number;
}

/** The single longest ride by distance. */
export interface BiggestRide {
  key: string;
  km: number;
}

/** Aggregated lifetime totals and records for a set of rides. */
export interface RideStats {
  /** Non-deleted rides counted. */
  rideCount: number;
  /** Sum of every ride's distance, in kilometres. */
  totalKm: number;
  /** Sum of every ride's moving time, in seconds. */
  totalMovingSec: number;
  /** Sum of every ride's elevation gain, in metres. */
  totalElevationM: number;
  /** Longest single ride, or null when no ride has a usable distance. */
  biggestRide: BiggestRide | null;
  /** Highest-distance day, or null when there are no datable rides. */
  bestDay: PeriodRecord | null;
  /** Highest-distance week (Monday-anchored), or null when none. */
  bestWeek: PeriodRecord | null;
  /** Highest-distance month, or null when none. */
  bestMonth: PeriodRecord | null;
}

/** A ride's distance in km: prefer the detail's "Distance", fall back to the summary, then the measured track. */
function rideKm(r: StatsRide): number {
  const fromText = parseKm((r.stats && r.stats["Distance"]) || r.distance || "");
  return fromText > 0 ? fromText : r.track_km > 0 ? r.track_km : 0;
}

/** Best (highest-distance) bucket at one granularity, or null when nothing is datable. */
function bestPeriod(rides: ReadonlyArray<StatsRide>, gran: "day" | "week" | "month"): PeriodRecord | null {
  const byBucket = new Map<string, PeriodRecord>();
  for (const r of rides) {
    const km = rideKm(r);
    const [sortKey, label] = bucketRide(r.key, gran);
    if (sortKey === "9999") continue; // undatable key — skip rather than pile into "Unknown"
    const e = byBucket.get(sortKey);
    if (e) {
      e.km += km;
      e.count += 1;
    } else {
      byBucket.set(sortKey, { label, km, count: 1 });
    }
  }
  let best: PeriodRecord | null = null;
  for (const e of byBucket.values()) {
    if (!best || e.km > best.km) best = e;
  }
  return best;
}

/**
 * Aggregate lifetime totals and distance records over a ride list. Deleted rides
 * are ignored — they no longer exist on the phone and would inflate the totals.
 */
export function computeStats(rides: ReadonlyArray<StatsRide>): RideStats {
  const live = rides.filter((r) => !r.deleted);

  let totalKm = 0;
  let totalMovingSec = 0;
  let totalElevationM = 0;
  let biggestRide: BiggestRide | null = null;

  for (const r of live) {
    const km = rideKm(r);
    totalKm += km;
    totalMovingSec += parseDurationSec((r.stats && r.stats["Moving time"]) || "");
    totalElevationM += parseMeters((r.stats && r.stats["Elevation gain"]) || "");
    if (km > 0 && (!biggestRide || km > biggestRide.km)) biggestRide = { key: r.key, km };
  }

  return {
    rideCount: live.length,
    totalKm,
    totalMovingSec,
    totalElevationM,
    biggestRide,
    bestDay: bestPeriod(live, "day"),
    bestWeek: bestPeriod(live, "week"),
    bestMonth: bestPeriod(live, "month"),
  };
}
