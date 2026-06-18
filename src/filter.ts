/**
 * Explore-list filters: pure predicates that narrow the cached rides before the
 * UI groups them. Deliberately side-effect-free (no DOM, no device) so the logic
 * is unit-testable in isolation — the wiring + chip rendering lives in main.ts.
 *
 * Every dimension is combined with AND; a filter at its neutral value ("all" /
 * "any" / null bound) is a no-op.
 */

import type { RideView } from "./controller";
import { isSynthesizedRideName } from "./parsing";
import { tagKey } from "./tags";

export type TriState = "any" | "yes" | "no";

export interface Filters {
  /** Strava upload status. "not-uploaded" = pending/unknown (eligible to upload),
   *  "processing" = an upload is mid-flight, "uploaded" = on Strava. */
  status: "all" | "uploaded" | "processing" | "not-uploaded";
  /** Route-preview (encoded track) presence. */
  gps: TriState;
  /** Full recorded GPX present in the local cache (real time + elevation). */
  cached: TriState;
  /** Historical wind resolved (Open-Meteo summary cached) for the ride. */
  wind: TriState;
  /** Inclusive average-wind-speed bounds in km/h (only meaningful with `wind: "yes"`);
   *  null means unbounded on that side. */
  windMin: number | null;
  windMax: number | null;
  /** Routed-destination presence (a ride that navigated/was tagged with a place). */
  destination: TriState;
  /** Real user-given name vs the auto time-of-day fallback ("Morning ride"). */
  named: TriState;
  /** Deletion: only deleted, hide deleted, or don't care. */
  deleted: "any" | "only" | "none";
  /** Which backend a ride came from: "all", or a specific source kind. */
  source: "all" | "beeline" | "gpx";
  /** Source device: "all", "__none__" (no device recorded), or a device model name. */
  device: string;
  /** Inclusive distance bounds in km; null means unbounded on that side. */
  distMin: number | null;
  distMax: number | null;
  /** Selected tags, as lowercase comparison keys (see tags.ts). OR semantics: a ride
   *  passes when it carries ANY selected tag. Empty = no-op. */
  tags: string[];
}

/** A fresh, fully-neutral filter set (shows every ride). */
export function emptyFilters(): Filters {
  return {
    status: "all",
    gps: "any",
    cached: "any",
    wind: "any",
    windMin: null,
    windMax: null,
    destination: "any",
    named: "any",
    deleted: "any",
    source: "all",
    device: "all",
    distMin: null,
    distMax: null,
    tags: [],
  };
}

/**
 * Best-effort distance in km for a ride. Reads the normalized `distance_km`
 * computed once on the ingestion path (so a comma-decimal "13,5km" filters as
 * 13.5, not 135); a ride with no captured distance counts as 0.
 */
export function rideKm(r: RideView): number {
  return r.distance_km ?? 0;
}

/** True when at least one dimension narrows the list (drives Clear + totals hint). */
export function filtersActive(f: Filters): boolean {
  return filterActiveCount(f) > 0;
}

/**
 * How many filter dimensions are currently narrowing the list (0 = neutral).
 * Distance counts once (min and/or max share the one "Distance" field group), so
 * the number matches the count of active controls a user sees in the bar. Drives
 * the mobile "Filters" toggle badge; `filtersActive` is just the `> 0` case, so
 * this stays the single source of truth for "is anything filtered".
 */
export function filterActiveCount(f: Filters): number {
  let n = 0;
  if (f.status !== "all") n++;
  if (f.gps !== "any") n++;
  if (f.cached !== "any") n++;
  if (f.wind !== "any") n++;
  if (f.windMin !== null || f.windMax !== null) n++;
  if (f.destination !== "any") n++;
  if (f.named !== "any") n++;
  if (f.deleted !== "any") n++;
  if (f.source !== "all") n++;
  if (f.device !== "all") n++;
  if (f.distMin !== null || f.distMax !== null) n++;
  if (f.tags.length > 0) n++;
  return n;
}

/** Does a ride pass every active filter? (AND across all dimensions.) */
export function matchesFilters(f: Filters, r: RideView): boolean {
  // Strava upload status. The three concrete buckets partition every ride:
  // "uploaded" (on Strava), "processing" (an upload is mid-flight), and
  // "not-uploaded" (everything else — pending/unknown — i.e. eligible to upload).
  // Deletion is orthogonal here; the separate `deleted` dimension handles it.
  if (f.status === "uploaded" && r.status !== "uploaded") return false;
  if (f.status === "processing" && r.status !== "processing") return false;
  if (f.status === "not-uploaded" && (r.status === "uploaded" || r.status === "processing"))
    return false;

  // Route-preview presence.
  const hasGps = r.track.length > 0;
  if (f.gps === "yes" && !hasGps) return false;
  if (f.gps === "no" && hasGps) return false;

  // Full recorded GPX cached locally (real time + elevation) — distinct from the
  // lightweight route preview the `gps` dimension checks.
  if (f.cached === "yes" && !r.gpx_cached) return false;
  if (f.cached === "no" && r.gpx_cached) return false;

  // Historical wind resolved (Open-Meteo summary cached) for the ride.
  if (f.wind === "yes" && !r.wind_resolved) return false;
  if (f.wind === "no" && r.wind_resolved) return false;

  // Average-wind-speed band (km/h). Only resolved rides carry a wind speed, so any
  // bound excludes unresolved (and no-data) rides outright — mirroring how the
  // distance band treats a missing distance.
  if (f.windMin !== null || f.windMax !== null) {
    const ws = r.wind_speed_kmh;
    if (ws == null) return false;
    if (f.windMin !== null && ws < f.windMin) return false;
    if (f.windMax !== null && ws > f.windMax) return false;
  }

  // Routed-destination presence. The location suffix is set only when the ride
  // navigated to a place (Beeline) or was tagged with one (imported GPX), so it
  // doubles as the "has destination" signal.
  const hasDestination = r.location.trim().length > 0;
  if (f.destination === "yes" && !hasDestination) return false;
  if (f.destination === "no" && hasDestination) return false;

  // Real user-given name vs the synthesized time-of-day fallback. A ride is "named"
  // when its title is non-empty AND not one of our auto "<time> ride" names.
  const hasName = r.title.trim().length > 0 && !isSynthesizedRideName(r.title);
  if (f.named === "yes" && !hasName) return false;
  if (f.named === "no" && hasName) return false;

  // Deletion.
  if (f.deleted === "only" && !r.deleted) return false;
  if (f.deleted === "none" && r.deleted) return false;

  // Which backend the ride came from.
  if (f.source !== "all" && r.source !== f.source) return false;

  // Source device the ride was scanned from.
  if (f.device === "__none__" && r.device_model) return false;
  if (f.device !== "all" && f.device !== "__none__" && r.device_model !== f.device)
    return false;

  // Distance band (km). A ride with no parseable distance counts as 0, so it
  // drops out once a lower bound is set but survives an upper-only bound.
  if (f.distMin !== null || f.distMax !== null) {
    const km = rideKm(r);
    if (f.distMin !== null && km < f.distMin) return false;
    if (f.distMax !== null && km > f.distMax) return false;
  }

  // Tags (OR): once any tag is selected, a ride must carry at least one of them.
  // Compared by lowercase key so casing never matters.
  if (f.tags.length > 0) {
    const keys = r.tags.map(tagKey);
    if (!f.tags.some((t) => keys.includes(t))) return false;
  }
  return true;
}

/** Apply the active filters to a ride list (identity when nothing is filtered). */
export function visibleRides(f: Filters, rides: RideView[]): RideView[] {
  return filtersActive(f) ? rides.filter((r) => matchesFilters(f, r)) : rides;
}
