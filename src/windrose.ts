/**
 * Wind-rose climatology: turn many (cell, day) hourly wind records into the
 * direction/speed statistics that power the Windalytics view.
 *
 * This module is pure and rendering-agnostic (like `windspeed.ts` is to
 * `windchart.ts`): it takes cached `CellDayWind` entries for ONE point and reduces
 * them to a wind rose (16 compass sectors × speed bins), a per-month breakdown, and
 * a vector-mean resultant — filtered by hour-of-day and month entirely in memory, so
 * dragging the time-of-day slider is instant and never refetches.
 *
 * Two design notes:
 *  - **Local time is approximated from longitude** (`round(lon/15)` hours). The cache
 *    stays in UTC (deterministic keys); we shift each hourly sample by that offset so
 *    "14:00" reads as roughly local clock time, and re-attribute its month/year after
 *    the shift (a late-night sample can fall in the previous local day). It's an
 *    approximation — no timezone database — good enough for climatology.
 *  - **Calm is separated, not binned.** Samples below `CALM_KMH` have no meaningful
 *    direction, so they're counted as calm and excluded from the directional sectors
 *    (the classic wind-rose convention).
 *
 * Wind data is by Open-Meteo.com (CC-BY 4.0).
 */

import type { CellDayWind } from "./weather";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const HOUR_MS = 3_600_000;

/** Below this speed the wind has no meaningful direction — counted as calm. */
export const CALM_KMH = 1;

/** Open-Meteo hourly variables we read out of a cached cell-day. */
const SPEED_KEY = "wind_speed_10m";
const DIR_KEY = "wind_direction_10m";

/** 16-point compass labels, index 0 = North, going clockwise. */
export const COMPASS_16 = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

/** Lower edges (km/h) of the rose speed bins; the last bin is open-ended. */
export const SPEED_BINS = [0, 5, 10, 15, 20, 30] as const;

/** Human labels for each speed bin (parallel to `SPEED_BINS`). */
export const SPEED_BIN_LABELS = ["<5", "5–10", "10–15", "15–20", "20–30", "30+"] as const;

/** One hourly wind observation, already shifted to approximate local time. */
export interface WindSample {
  /** UTC instant of the sample (ms). */
  ms: number;
  /** Approximate local hour-of-day (0–23). */
  hour: number;
  /** Approximate local calendar month (1–12). */
  month: number;
  /** Approximate local calendar year. */
  year: number;
  /** Meteorological direction the wind blows FROM (0=N, clockwise), degrees. */
  fromDeg: number;
  speedKmh: number;
}

/** A wind rose: directional sector × speed-bin counts plus summary scalars. */
export interface WindRose {
  /** `counts[sector][speedBin]` — sample counts; sector 0 = N. */
  counts: number[][];
  /** Non-calm samples that landed in a sector. */
  total: number;
  /** Calm samples (< `CALM_KMH`), excluded from the sectors. */
  calm: number;
  /** All samples considered (calm + directional). */
  n: number;
  /** Vector-mean wind: the resultant FROM-direction and its (damped) magnitude. */
  meanVector: { fromDeg: number; speedKmh: number };
  /** Scalar-mean wind speed over all considered samples (km/h). */
  meanSpeedKmh: number;
}

/** Which samples to fold into a rose. */
export interface RoseFilter {
  /** Keep only this local hour-of-day, or `"all"` for the whole-day climatology. */
  hour: number | "all";
  /** Keep only these months (1–12); empty/undefined = all months. */
  months?: Set<number>;
}

/** Approximate local-time offset (whole hours) from longitude. */
export function localOffsetHours(lon: number): number {
  return Math.round((((((lon + 180) % 360) + 360) % 360) - 180) / 15);
}

/** The 16-point sector index (0 = N) a FROM-direction falls in. */
export function sectorIndex(fromDeg: number): number {
  return ((Math.round((((fromDeg % 360) + 360) % 360) / 22.5) % 16) + 16) % 16;
}

/** The speed-bin index for a wind speed (km/h). */
export function speedBinIndex(kmh: number): number {
  let i = SPEED_BINS.length - 1;
  while (i > 0 && kmh < SPEED_BINS[i]) i--;
  return i;
}

/** Compass label (e.g. "WSW") for a FROM-direction. */
export function dirLabel(fromDeg: number): string {
  return COMPASS_16[sectorIndex(fromDeg)];
}

/**
 * Flatten cached cell-days into one local-time sample per non-null hour, optionally
 * clipped to a UTC time window (so the year slider can narrow without refetching).
 * `noData` days and missing hourly readings are skipped.
 */
export function flattenSamples(
  days: CellDayWind[],
  lon: number,
  minMs?: number,
  maxMs?: number,
): WindSample[] {
  const offMs = localOffsetHours(lon) * HOUR_MS;
  const out: WindSample[] = [];
  for (const d of days) {
    if (d.noData) continue;
    const spd = d.hourly?.[SPEED_KEY];
    const dir = d.hourly?.[DIR_KEY];
    if (!spd || !dir) continue;
    const [y, m, dd] = d.dayISO.split("-").map(Number);
    if (!y || !m || !dd) continue;
    const baseUtc = Date.UTC(y, m - 1, dd);
    const steps = d.step || Math.min(spd.length, dir.length) || 24;
    for (let h = 0; h < steps; h++) {
      const s = spd[h];
      const dg = dir[h];
      if (s == null || dg == null) continue;
      const utcMs = baseUtc + h * HOUR_MS;
      if (minMs != null && utcMs < minMs) continue;
      if (maxMs != null && utcMs > maxMs) continue;
      const local = new Date(utcMs + offMs);
      out.push({
        ms: utcMs,
        hour: local.getUTCHours(),
        month: local.getUTCMonth() + 1,
        year: local.getUTCFullYear(),
        fromDeg: ((dg % 360) + 360) % 360,
        speedKmh: s,
      });
    }
  }
  return out;
}

/** Reduce pre-flattened samples into a wind rose under an hour/month filter. */
export function roseFromSamples(samples: WindSample[], filter: RoseFilter): WindRose {
  const counts: number[][] = Array.from({ length: 16 }, () =>
    new Array(SPEED_BINS.length).fill(0),
  );
  const months = filter.months;
  let calm = 0;
  let total = 0;
  let n = 0;
  let sumFx = 0;
  let sumFy = 0;
  let sumSpeed = 0;
  for (const s of samples) {
    if (filter.hour !== "all" && s.hour !== filter.hour) continue;
    if (months && months.size > 0 && !months.has(s.month)) continue;
    n++;
    sumSpeed += s.speedKmh;
    const r = s.fromDeg * D2R;
    sumFx += Math.sin(r) * s.speedKmh;
    sumFy += Math.cos(r) * s.speedKmh;
    if (s.speedKmh < CALM_KMH) {
      calm++;
      continue;
    }
    total++;
    counts[sectorIndex(s.fromDeg)][speedBinIndex(s.speedKmh)]++;
  }
  return {
    counts,
    total,
    calm,
    n,
    meanVector: {
      fromDeg: n > 0 ? (((Math.atan2(sumFx, sumFy) * R2D) % 360) + 360) % 360 : 0,
      speedKmh: n > 0 ? Math.hypot(sumFx, sumFy) / n : 0,
    },
    meanSpeedKmh: n > 0 ? sumSpeed / n : 0,
  };
}

/** Convenience: flatten + aggregate in one call. */
export function aggregateRose(
  days: CellDayWind[],
  filter: RoseFilter & { lon: number; minMs?: number; maxMs?: number },
): WindRose {
  return roseFromSamples(flattenSamples(days, filter.lon, filter.minMs, filter.maxMs), filter);
}

/** Twelve roses (index 0 = January) sharing one hour filter — the small-multiples. */
export function monthlyRoses(samples: WindSample[], hour: number | "all"): WindRose[] {
  const out: WindRose[] = [];
  for (let m = 1; m <= 12; m++) {
    out.push(roseFromSamples(samples, { hour, months: new Set([m]) }));
  }
  return out;
}

/** Per-sector fraction (0..1) of a rose's directional samples — the heatmap row. */
export function sectorFractions(rose: WindRose): number[] {
  const out = new Array(16).fill(0);
  if (rose.total <= 0) return out;
  for (let i = 0; i < 16; i++) {
    let c = 0;
    for (const v of rose.counts[i]) c += v;
    out[i] = c / rose.total;
  }
  return out;
}

/** Largest single sector+bin count in a rose — the radial scale for drawing it. */
export function roseMaxSector(rose: WindRose): number {
  let max = 0;
  for (let i = 0; i < 16; i++) {
    let c = 0;
    for (const v of rose.counts[i]) c += v;
    if (c > max) max = c;
  }
  return max;
}
