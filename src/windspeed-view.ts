/**
 * GPX Toolkit — Wind/Speed view (the wind-vs-speed scatter).
 *
 * Extracted from `main.ts`. For every roughly-straight stretch of a wind-resolved
 * ride it plots a point — headwind→left, tailwind→right, speed up the side — and
 * fits a line: the intercept is your still-air speed, the slope how much a km/h of
 * tailwind helps. Speed is only trustworthy from a ride's FULL recorded GPX (real
 * per-point timestamps), so rides without it are counted but left out, and the
 * heavy per-ride segmentation is cached (independent of the date range) so dragging
 * the date slider re-filters instantly instead of re-sweeping.
 *
 * Self-contained behind a `WindSpeedDeps` seam (the controller, live ride list and
 * the shared date-range control are injected as lazy closures); it imports the pure
 * helpers (windspeed maths, the chart renderer, formatters) directly.
 */

import { activeView } from "./app-state";
import type { RideView } from "./controller";
import type { DateRange } from "./mapview";
import { compareRideKeysDesc, rideShortLabel } from "./parsing";
import type { LatLon } from "./track";
import { statNum } from "./ui";
import { drawWindSpeedChart } from "./windchart";
import {
  linearRegression,
  type SegmentOpts,
  segmentRide,
  speedCapIndices,
  type WindSeg,
} from "./windspeed";

/** What the view needs from the app (injected once via `initWindSpeedView`). */
export interface WindSpeedDeps {
  /** The live (possibly-deleted-included) ride list. */
  getRides(): RideView[];
  /** Filter rides to a date selection (the app's shared range helper). */
  ridesInRange(rides: RideView[], range: DateRange): RideView[];
  /** The current Wind/Speed date selection, or null for the full span. */
  analyticsRange(): DateRange | null;
  /** Speed under which a moment counts as stopped (settings). */
  movingThresholdKmh(): number;
  /** A ride's wind-resolution version stamp (busts the segment cache). */
  weatherFetchedAt(key: string): string;
  /** Wind samples + the point/time series for a ride (null when unresolved). */
  windSamples(key: string): Promise<{
    points: LatLon[];
    times: number[];
    eles: (number | null)[];
    along: (number | null)[];
    realTimes: boolean;
  } | null>;
  /** Sync the shared date-range control's bounds for this view. */
  refreshRange(): void;
  /** (Re)mount the shared date-range slider for this view. */
  syncRangeControl(): void;
}

/** A ride's memoized segments plus why it may contribute none. */
type RideSegEntry = {
  segs: WindSeg[];
  /** ok = full timed GPX, segments usable; needgpx = resolved but no full timed
   *  track (speed would be synthetic); skip = no usable wind (noData / unaligned). */
  status: "ok" | "needgpx" | "skip";
};

let deps!: WindSpeedDeps;

const segCacheByUid = new Map<string, RideSegEntry>();
let analyticsSeq = 0;
/** True while an analytics sweep is in flight. Lets a passive re-render coalesce into
 *  a single post-run rerun instead of aborting + restarting the live sweep. */
let analyticsRunning = false;
/** A state change asked the view to refresh while a sweep was running; the running
 *  sweep fires exactly one rerun when it finishes (if still on the tab). */
let analyticsRerunQueued = false;
/** |net grade| above this (percent) means a segment isn't "flat". */
const FLAT_GRADE_PCT = 1.5;

/** Wire the view's dependencies. Call once at startup. */
export function initWindSpeedView(d: WindSpeedDeps): void {
  deps = d;
}

/** Memo key for a ride's segments: uid + wind version + full-GPX presence, so a
 *  re-resolve or a full-GPX fetch busts it. */
function segKey(r: RideView): string {
  return `${r.key}::${deps.weatherFetchedAt(r.key)}::${r.gpx_cached ? "g" : "_"}`;
}

/** The non-deleted rides within the current Wind/Speed date selection. */
export function windSpeedVisibleRides(): RideView[] {
  const range = deps.analyticsRange();
  const rides = deps.getRides();
  const visible = range ? deps.ridesInRange(rides, range) : rides;
  return visible.filter((r) => !r.deleted);
}

/** Current max-speed cap (km/h) from the slider (20..80), defaulting to 50. Segments
 *  whose average speed exceeds this are dropped as GPS glitches. */
function analyticsMaxSpeed(): number {
  const el = document.getElementById("maxSpeed") as HTMLInputElement | null;
  const v = el ? parseInt(el.value, 10) : 50;
  return Number.isFinite(v) ? Math.max(20, Math.min(80, v)) : 50;
}

/** Render the empty/blocked state, adapting message + CTA to whether the blocker is
 *  unresolved wind or missing full GPX. */
function renderAnalyticsEmpty(kind: "wind" | "gpx", n: number): void {
  const el = document.getElementById("analyticsEmpty");
  if (!el) return;
  if (kind === "wind") {
    el.innerHTML =
      "See how much the wind speeds you up or slows you down. This needs rides with " +
      "<b>resolved wind</b> — once some are resolved, each roughly-straight stretch of a " +
      "ride becomes a point: headwind on the left, tailwind on the right, your speed up the " +
      'side. <button type="button" class="linkbtn" id="analyticsResolveEmpty">' +
      "Resolve wind for these rides</button>";
  } else {
    el.innerHTML =
      `Wind is resolved, but charting speed needs each ride's <b>full GPX</b> (real ` +
      `timestamps). Without it, a segment's speed would be guessed from evenly-spaced ` +
      `points rather than your real pace, so ${n === 1 ? "this ride is" : `these ${n} rides are`} ` +
      `left out. <button type="button" class="linkbtn" id="analyticsFetchGpxEmpty">` +
      `Fetch full GPX for these rides</button>`;
  }
}

/** Show each action button only when it can act on rides in range, with the affected
 *  count in its label. */
function syncAnalyticsActions(inRange: RideView[]): void {
  const unresolved = inRange.filter((r) => !r.wind_resolved && !!r.track).length;
  const needGpx = inRange.filter((r) => r.source !== "gpx" && !r.gpx_cached).length;
  const resolveBtn = document.getElementById("analyticsResolve");
  if (resolveBtn) {
    resolveBtn.style.display = unresolved === 0 ? "none" : "";
    resolveBtn.textContent =
      unresolved === 1 ? "Resolve wind for 1 ride" : `Resolve wind for ${unresolved} rides`;
  }
  const gpxBtn = document.getElementById("analyticsFetchGpx");
  if (gpxBtn) {
    gpxBtn.style.display = needGpx === 0 ? "none" : "";
    gpxBtn.textContent =
      needGpx === 1 ? "Fetch full GPX for 1 ride" : `Fetch full GPX for ${needGpx} rides`;
  }
}

/** Show (or clear) a calm centred message over the chart area without changing the
 *  page layout. Pass a 0..1 `progress` to add a determinate bar (analysing sweep). */
function showChartMessage(text: string | null, progress?: number, detail?: string): void {
  const el = document.getElementById("analyticsChartMsg");
  if (!el) return;
  if (text) {
    if (progress !== undefined) {
      const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
      el.innerHTML =
        `<span class="cm-card"><b class="cm-head">${text}</b>` +
        (detail ? `<span class="cm-detail">${detail}</span>` : "") +
        `<div class="chart-msg-bar"><i style="width:${pct}%"></i></div></span>`;
    } else {
      el.innerHTML = `<span>${text}</span>`;
    }
    el.style.display = "flex";
  } else {
    el.style.display = "none";
    el.textContent = "";
  }
}

/** Yield to the browser so a just-set overlay actually paints before more blocking
 *  work. Two rAFs guarantees a committed frame across engines. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Blank the scatter canvas (used when a range has no points to draw). */
function clearChart(): void {
  const canvas = document.getElementById("windSpeedChart") as HTMLCanvasElement | null;
  const ctx = canvas?.getContext("2d");
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/** Entry point: (re)render the Wind/Speed view, coalescing reruns during a sweep. */
export async function mountWindSpeedView(opts: { fit?: boolean } = {}): Promise<void> {
  if (analyticsRunning) {
    analyticsRerunQueued = true;
    return;
  }
  const my = ++analyticsSeq;
  analyticsRunning = true;
  try {
    await runAnalyticsView(my, opts);
  } finally {
    analyticsRunning = false;
    if (analyticsRerunQueued && activeView() === "analytics") {
      analyticsRerunQueued = false;
      void mountWindSpeedView();
    }
  }
}

async function runAnalyticsView(my: number, _opts: { fit?: boolean } = {}): Promise<void> {
  deps.refreshRange();
  const inRange = windSpeedVisibleRides();
  const resolved = inRange.filter((r) => r.wind_resolved);

  const empty = document.getElementById("analyticsEmpty");
  const body = document.getElementById("analyticsBody");
  deps.syncRangeControl();

  // Cold first run — nothing resolved anywhere yet → the full onboarding guide.
  const anyResolvedEver = deps.getRides().some((r) => !r.deleted && r.wind_resolved);
  if (!anyResolvedEver) {
    renderAnalyticsEmpty("wind", 0);
    empty?.classList.remove("hidden");
    body?.classList.add("hidden");
    return;
  }

  empty?.classList.add("hidden");
  body?.classList.remove("hidden");
  syncAnalyticsActions(inRange);

  const opts: SegmentOpts = { stopKmh: deps.movingThresholdKmh() };
  const allResolved = deps.getRides().filter((r) => !r.deleted && r.wind_resolved);
  const pending = allResolved
    .filter((r) => !segCacheByUid.has(segKey(r)))
    .sort((a, b) => compareRideKeysDesc(a.key, b.key));
  let done = 0;
  let lastPaint = 0;
  const sweepStart = performance.now();
  for (const r of pending) {
    const key = segKey(r);
    let entry: RideSegEntry;
    try {
      const s = await deps.windSamples(r.key);
      if (my !== analyticsSeq) return;
      if (!s) entry = { segs: [], status: "skip" };
      else if (!s.realTimes) entry = { segs: [], status: "needgpx" };
      else
        entry = {
          segs: segmentRide(s.points, s.times, s.eles, s.along, opts, r.key),
          status: "ok",
        };
    } catch (err) {
      console.error(`analytics: skipping ${r.key} —`, err);
      entry = { segs: [], status: "skip" };
    }
    if (my !== analyticsSeq) return;
    segCacheByUid.set(key, entry);
    done++;
    const now = performance.now();
    if (now - sweepStart >= 200 && (now - lastPaint >= 100 || done === pending.length)) {
      lastPaint = now;
      const label = rideShortLabel(r.key);
      showChartMessage(
        "Analysing rides…",
        done / pending.length,
        `${label ? `${label} · ` : ""}${done} / ${pending.length}`,
      );
      await nextPaint();
      if (my !== analyticsSeq) return;
    }
  }
  if (my !== analyticsSeq) return;

  const flatOnly =
    (document.getElementById("flatOnly") as HTMLInputElement | null)?.checked ?? false;
  let usableRides = 0;
  let needGpxRides = 0;
  let skippedRides = 0;
  const segs: WindSeg[] = [];
  for (const r of resolved) {
    const entry = segCacheByUid.get(segKey(r));
    if (!entry) continue;
    if (entry.status === "needgpx") needGpxRides++;
    if (entry.status === "skip") skippedRides++;
    if (entry.status !== "ok") continue;
    usableRides++;
    for (const seg of entry.segs) {
      if (flatOnly) {
        if (!Number.isFinite(seg.netGradePct)) continue;
        if (Math.abs(seg.netGradePct) > FLAT_GRADE_PCT) continue;
      }
      segs.push(seg);
    }
  }

  // Drop physically-impossible segments above the Max-speed cap (GPS glitches).
  const maxSpeed = analyticsMaxSpeed();
  const out = document.getElementById("maxSpeedOut") as HTMLOutputElement | null;
  if (out) out.value = `${maxSpeed} km/h`;
  const keep = speedCapIndices(
    segs.map((s) => s.avgSpeedKmh),
    maxSpeed,
  );
  const shown = keep.map((i) => segs[i]);
  const trimmed = segs.length - shown.length;

  const xs = shown.map((s) => s.avgAlongKmh);
  const ys = shown.map((s) => s.avgSpeedKmh);
  const w = shown.map((s) => s.distanceKm);
  const reg = linearRegression(xs, ys, w);

  const cards = document.getElementById("analyticsCards");
  if (cards) {
    const has = shown.length > 0;
    cards.innerHTML = [
      statNum({
        value: has ? `${reg.intercept.toFixed(1)} km/h` : "—",
        label: "still-air speed",
      }),
      statNum({
        value: has ? `${reg.slope >= 0 ? "+" : ""}${reg.slope.toFixed(2)}` : "—",
        label: "km/h per km/h of tailwind",
      }),
      statNum({ value: has ? reg.r2.toFixed(2) : "—", label: "R² (wind explains)" }),
      statNum({
        value: String(shown.length),
        label: shown.length === 1 ? "segment" : "segments",
      }),
    ].join("");
  }
  const note = document.getElementById("analyticsNote");
  if (note) {
    const unresolved = inRange.filter((r) => !r.wind_resolved && !!r.track).length;
    note.textContent =
      ` ${usableRides} ride${usableRides === 1 ? "" : "s"} analysed` +
      (needGpxRides ? ` · ${needGpxRides} need full GPX` : "") +
      (unresolved ? ` · ${unresolved} not yet wind-resolved` : "") +
      (skippedRides ? ` · ${skippedRides} skipped` : "") +
      (flatOnly ? " · flat segments only" : "") +
      (trimmed ? ` · ${trimmed} over ${maxSpeed} km/h dropped` : "");
  }
  const canvas = document.getElementById("windSpeedChart") as HTMLCanvasElement | null;
  if (shown.length === 0) {
    clearChart();
    showChartMessage(
      resolved.length === 0
        ? "No wind-resolved rides in this date range."
        : needGpxRides > 0
          ? `${needGpxRides} ride${needGpxRides === 1 ? "" : "s"} in this range need full GPX for speed.`
          : "No segments match the current filters.",
    );
  } else {
    showChartMessage(null);
    if (canvas) drawWindSpeedChart(canvas, shown, reg);
  }
}
