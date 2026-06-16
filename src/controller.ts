/**
 * In-browser controller — the backend-free equivalent of the Python `server.Backend`.
 *
 * Holds the Store, the JobQueue, and a lazily-connected `RideSource` (the Beeline
 * cloud account). Exposes the same operations the old HTTP API did (state / scan /
 * status / upload / cancel / clear / settings), but as direct method calls. Instead
 * of the UI polling `/api/state`, the controller emits a "change" event whenever
 * anything moves, and the UI re-renders.
 */

import { GpxCache } from "./gpxcache";
import { JobQueue, type JobsSnapshot, type Report, type Task } from "./jobs";
import {
  type RideDetail,
  type RideMetrics,
  rideDatetime,
  rideMonth,
  rideShortLabel,
  sinceFromPreset,
} from "./parsing";
import {
  type GpxFile,
  type GpxMode,
  gpxDownloadName,
  gpxFilename,
  type RideSource,
  type SourceFactory,
} from "./source";
import { monthKey, monthLabel, type Settings, type Store, type UpsertFields } from "./store";
import { encodedTrackToGpx, extractFullTrack, type FullTrack, gpxToRoughTrack } from "./track";
import { buildZip } from "./zip";

export interface RideView extends RideMetrics {
  key: string;
  title: string;
  /** Extra location suffix gathered at check time (e.g. ", Amstelveen"); "" when none. */
  location: string;
  status: string;
  track: string;
  /** Lat/lon points read from the downloaded GPX (0 when none captured). */
  track_src_points: number;
  /** Points kept in the rough track after simplification (0 when none). */
  track_points: number;
  /** Length of the source GPX track in kilometres (0 when unknown). */
  track_km: number;
  /** Size of the downloaded GPX file in bytes (0 when unknown). */
  track_bytes: number;
  // The normalized numeric metrics (distance_km, moving_sec, avg_speed_kmh, …;
  // null = unknown) are inherited from RideMetrics. They are the single source of
  // truth for all maths and display — parsed once on the ingestion path, never
  // re-derived from a raw string here. `distance_km` additionally falls back to the
  // measured track length when no reported distance was captured (see state()).
  /** Source label this ride was last scanned from ("" when never recorded). */
  device_model: string;
  month_key: string;
  month_label: string;
  uploaded_at: string;
  deleted: boolean;
  deleted_at: string;
  /** True when the full recorded GPX for this ride is cached on disk (see GpxCache). */
  gpx_cached: boolean;
}

export interface AppState {
  rides: RideView[];
  jobs: JobsSnapshot;
  settings: Settings;
  connected: boolean;
  device: string;
}

export type Transport = SourceFactory;

/** A pulled GPX file handed to the UI for download. */
export type GpxListener = (file: GpxFile) => void;

export class Controller {
  readonly store: Store;
  readonly jobs: JobQueue;

  private source: RideSource | null = null;
  private deviceLabel = "";
  private readonly listeners = new Set<() => void>();
  private readonly gpxListeners = new Set<GpxListener>();
  /**
   * Full recorded tracks (real per-point time + elevation), fetched on demand and
   * kept in memory for THIS SESSION ONLY — never persisted. They are ~500 KB each,
   * so caching them across reloads would bloat IndexedDB at the thousands-of-rides
   * scale; a revisit simply re-fetches.
   */
  private readonly fullTracks = new Map<string, FullTrack>();

  constructor(
    private readonly sourceFactory: SourceFactory,
    store: Store,
    /** Persistent compressed full-GPX cache. Defaults to an ephemeral in-memory
     *  one (demo/tests that don't supply a durable backend). */
    private readonly gpxCache: GpxCache = GpxCache.memory(),
  ) {
    this.store = store;
    this.jobs = new JobQueue(
      (task, report) => this.runTask(task, report),
      () => this.notify(),
    );
  }

  // -- change notification ----------------------------------------------

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Subscribe to pulled GPX files (for triggering a browser download). */
  onGpx(fn: GpxListener): () => void {
    this.gpxListeners.add(fn);
    return () => this.gpxListeners.delete(fn);
  }

  private emitGpx(file: GpxFile): void {
    for (const fn of this.gpxListeners) fn(file);
  }

  /**
   * Build a route-only ("light") GPX file for one ride synthesized from its cached
   * polyline — no network, no timestamps/elevation. Returns the file, or null when
   * the ride has no usable cached route. Shared by the light export path and the
   * full-export fallback (when the export gateway is unreachable but we still hold
   * the route).
   */
  private buildCachedLightGpx(key: string): GpxFile | null {
    const rec = this.store.rides.get(key);
    if (!(rec && rec.source === "beeline" && rec.track)) return null;
    const title = rec.title || rec.title_base || "";
    const xml = encodedTrackToGpx(rec.track, title || rideShortLabel(key) || key);
    if (!xml) return null;
    return {
      key,
      filename: gpxFilename(key),
      downloadName: gpxDownloadName(key, title),
      bytes: new TextEncoder().encode(xml),
    };
  }

  /**
   * Build a FULL GPX file for one ride from the on-disk gzip cache (real per-point
   * time + elevation), or null when it isn't cached. Also rehydrates the in-memory
   * full track so the ride's map shows real data offline. No network — this is the
   * reuse path that lets a re-download/bundle skip re-fetching already-saved rides.
   */
  private async buildCachedFullGpx(key: string): Promise<GpxFile | null> {
    const bytes = await this.gpxCache.get(key);
    if (!bytes) return null;
    const rec = this.store.rides.get(key);
    const title = rec ? rec.title || rec.title_base || "" : "";
    if (!this.fullTracks.has(key)) {
      try {
        this.fullTracks.set(key, extractFullTrack(new TextDecoder().decode(bytes)));
      } catch {
        // A corrupt cached GPX still downloads fine; only the map upgrade is skipped.
      }
    }
    return {
      key,
      filename: gpxFilename(key),
      downloadName: gpxDownloadName(key, title),
      bytes,
    };
  }

  /** The in-memory full track for a ride, or null when not fetched this session. */
  getFullTrack(key: string): FullTrack | null {
    return this.fullTracks.get(key) ?? null;
  }

  /**
   * Rehydrate a ride's FULL recorded track from the persistent GPX cache into the
   * session map, if it's cached and not already loaded. No network — this is what
   * lets the offline map/profile show real time + elevation after a reload (the
   * gzipped GPX survives in IndexedDB even though the parsed in-memory track does
   * not). Returns the track, or null when the ride isn't cached or won't parse.
   */
  async loadCachedFullTrack(key: string): Promise<FullTrack | null> {
    const existing = this.fullTracks.get(key);
    if (existing) return existing;
    const bytes = await this.gpxCache.get(key);
    if (!bytes) return null;
    try {
      const ft = extractFullTrack(new TextDecoder().decode(bytes));
      this.fullTracks.set(key, ft);
      this.notify();
      return ft;
    } catch {
      return null; // corrupt cached GPX — leave it to a fresh fetch
    }
  }

  /**
   * Fetch (or return the cached) FULL recorded track for one ride — the real ~1 Hz
   * trace with per-point time + elevation. Interactive (not queued): the UI awaits
   * it to upgrade a ride's map. Checks the session map, then the persistent GPX
   * cache (so it works offline), and only then hits the source. Throws when the
   * ride has no recorded track or — when nothing is cached — the source isn't connected.
   */
  async fetchFullTrack(key: string): Promise<FullTrack> {
    const cached = this.fullTracks.get(key);
    if (cached) return cached;
    const fromCache = await this.loadCachedFullTrack(key);
    if (fromCache) return fromCache;
    const source = this.sourceFor();
    const ft = await source.fetchFullTrack(key);
    this.fullTracks.set(key, ft);
    this.notify();
    return ft;
  }

  // -- connection --------------------------------------------------------

  get connected(): boolean {
    return this.source !== null;
  }

  async connect(): Promise<void> {
    if (this.source) return;
    const source = await this.sourceFactory();
    this.source = source;
    this.deviceLabel = source.label();
    this.notify();
  }

  async disconnect(): Promise<void> {
    if (this.source) {
      await this.source.close();
    }
    this.source = null;
    this.deviceLabel = "";
    this.notify();
  }

  /** The connected source, or throw if nothing is connected. */
  private sourceFor(): RideSource {
    if (!this.source) {
      throw new Error("Not connected — sign in first.");
    }
    return this.source;
  }

  /**
   * Per-ride attribution stamped onto every record we write while connected, so
   * the cache records which source the info came from. Empty fields are omitted
   * so they never overwrite a known value.
   */
  private deviceFields(): UpsertFields {
    return this.source ? this.source.deviceFields() : {};
  }

  // -- state for the UI --------------------------------------------------

  state(): AppState {
    const records = [...this.store.rides.values()].sort((a, b) => a.key.localeCompare(b.key));
    const rides: RideView[] = records.map((r) => {
      // Split the fuller checked title into the scan name + colored location suffix.
      const base = r.title_base;
      const full = r.title;
      const hasSuffix = base !== "" && full.startsWith(base) && full.length > base.length;
      // The metrics are already normalized numbers on the record; copy them as-is.
      // Distance additionally falls back to the measured track length when no
      // reported distance was ever captured, so a GPX-only ride still shows a size.
      const distance_km =
        r.distance_km != null && r.distance_km > 0
          ? r.distance_km
          : r.track_km > 0
            ? r.track_km
            : null;
      return {
        key: r.key,
        title: hasSuffix ? base : full,
        location: hasSuffix ? full.slice(base.length) : "",
        status: r.strava_status,
        track: r.track,
        track_src_points: r.track_src_points,
        track_points: r.track_points,
        track_km: r.track_km,
        track_bytes: r.track_bytes,
        distance_km,
        moving_sec: r.moving_sec,
        elapsed_sec: r.elapsed_sec,
        avg_speed_kmh: r.avg_speed_kmh,
        max_speed_kmh: r.max_speed_kmh,
        elevation_gain_m: r.elevation_gain_m,
        elevation_loss_m: r.elevation_loss_m,
        device_model: r.device_model,
        month_key: monthKey(r),
        month_label: monthLabel(r),
        uploaded_at: r.uploaded_at,
        deleted: r.deleted,
        deleted_at: r.deleted_at,
        gpx_cached: this.gpxCache.has(r.key),
      };
    });
    return {
      rides,
      jobs: this.jobs.snapshot(),
      settings: { ...this.store.settings },
      connected: this.connected,
      device: this.deviceLabel,
    };
  }

  // -- task dispatch (runs on the queue worker) --------------------------

  private async runTask(task: Task, report: Report): Promise<void> {
    if (task.kind === "scan") await this.doScan(task, report);
    else if (task.kind === "upload") await this.doUpload(task, report);
    else if (task.kind === "download-gpx") await this.doDownloadGpx(task, report);
    else if (task.kind === "rename") await this.doRename(task, report);
    else if (task.kind === "delete") await this.doDelete(task, report);
  }

  private async doScan(task: Task, report: Report): Promise<void> {
    const preset = (task.payload.preset as string) ?? "all";
    const days = (task.payload.days as number | null) ?? null;
    const since = sinceFromPreset(preset, days);
    const label = preset !== "custom" ? preset : `last ${days}d`;
    const source = this.sourceFor();
    let cancelled = false;
    const rep = (msg: string): boolean => {
      const c = report(msg);
      if (c) cancelled = true;
      return c;
    };
    rep(`scanning (${label})…`);
    const seen = new Set<string>();
    const { cards, complete } = await source.enumerateCatalog(rep, since, (fresh) => {
      // Persist and surface each page of rides the moment they are found.
      for (const c of fresh) {
        seen.add(c.key);
        this.store.upsert(c.key, {
          ...this.deviceFields(),
          title_base: c.title,
          distance_km: c.distance_km,
          elapsed_sec: c.elapsed_sec,
          // A source may already know the full record at scan time (Beeline fetches
          // track + stats + Strava status in one request); merge those when present.
          ...(c.fields ?? {}),
        });
      }
      this.store.save();
      this.notify();
    });
    // A scan reads the COMPLETE list for its window, so any ride we knew about
    // within that window but did not see has been deleted from the source. Only
    // reconcile when the scan both ran to completion AND was verified to have read
    // the list end-to-end (`complete`). A cancelled scan is partial, and an
    // incomplete scan is unreliable — in either case treating unseen rides as
    // deleted would be wrong.
    let removed = 0;
    if (!cancelled && complete) {
      for (const r of this.store.rides.values()) {
        if (r.deleted || seen.has(r.key)) continue;
        const dt = rideDatetime(r.key);
        if (dt === null) continue; // can't place it in the window — leave it be
        if (since !== null && dt < since) continue; // outside the scanned window
        if (this.store.markDeleted(r.key)) removed++;
      }
      if (removed) {
        this.store.save();
        this.notify();
      }
    }
    const suffix = removed ? `, ${removed} deleted` : "";
    report(`scan done (${label}): ${cards.length} rides${suffix}`);
  }

  private async doUpload(task: Task, report: Report): Promise<void> {
    const source = this.sourceFor();
    let uploaded = 0;
    let removed = 0;
    const failures: string[] = [];
    // Seed live progress so the queue panel shows "0 of N" the moment work starts;
    // each processed ride bumps `done` below.
    task.progress = { done: 0, total: task.keys.length };
    const details = await source.processTargets(
      new Set(task.keys),
      (msg) => report(msg),
      (d) => {
        // Persist and surface each ride's status the moment it is read/uploaded.
        this.persistDetail(d);
        if (d.stravaStatus === "uploaded") uploaded++;
        if (task.progress) task.progress.done++;
      },
      (missing) => {
        // Searched the whole list and never found these → deleted from the source.
        for (const key of missing) if (this.store.markDeleted(key)) removed++;
        if (removed) {
          this.store.save();
          this.notify();
        }
      },
      (key, reason) => {
        // One ride threw mid-sweep: it was isolated and skipped so the rest still
        // ran. Collect it and surface every failure as one persistent error below.
        failures.push(`${rideShortLabel(key) || key}: ${reason}`);
        if (task.progress) task.progress.done++;
      },
    );
    const suffix = removed ? `, ${removed} deleted` : "";
    report(`done: ${uploaded} now on Strava (${details.length} processed)${suffix}`);

    if (failures.length) {
      // Fail the task so the UI shows a persistent, acknowledgeable error with full
      // per-ride detail — not a status message that just blinks past. The rides that
      // did succeed are already persisted above; this only reports the ones that didn't.
      const header = `${failures.length} of ${task.keys.length} ride${
        task.keys.length === 1 ? "" : "s"
      } failed to upload (${details.length} succeeded):`;
      throw new Error([header, ...failures.map((f) => `  • ${f}`)].join("\n"));
    }
  }

  /**
   * Persist a freshly read ride detail (title, Strava status, metrics) and surface
   * it. The detail's normalized numbers flow straight in via upsert, which only
   * overwrites a metric when the new figure is known — so a Check fills in the
   * fuller stats without clobbering anything an earlier pass already captured.
   */
  private persistDetail(d: RideDetail): void {
    this.store.upsert(d.key, {
      ...this.deviceFields(),
      title: d.title,
      strava_status: d.stravaStatus,
      ...d.metrics,
    });
    this.store.save();
    this.notify();
  }

  private async doDownloadGpx(task: Task, report: Report): Promise<void> {
    // Export each ride's route as a GPX file handed to the UI to write to disk.
    let removed = 0;
    let succeeded = 0;
    const failures: string[] = [];
    // Rides whose full export was unreachable but that carry a cached route, so we
    // can still hand the user a route-only GPX instead of failing outright.
    const degraded: string[] = [];
    const mode: GpxMode = (task.payload.mode as GpxMode) ?? "light";
    // Whether the produced files are handed to the browser to save. When false
    // (the "Fetch full GPX" action), the full sweep still runs — fetching, parsing
    // the real track into the session map, and caching the gzipped GPX — but NO file
    // is written to disk. This pre-warms the offline cache for the selected rides
    // without spawning a download. Only meaningful in full mode (light GPX is
    // synthesized locally and has nothing to cache).
    const save = task.payload.save !== false;
    // Seed live progress so the queue panel shows "0 of N" while the sweep runs.
    task.progress = { done: 0, total: task.keys.length };

    // Accumulate every produced file here instead of emitting them one-by-one. A
    // single file is delivered as a plain GPX; more than one is bundled into a
    // single .zip below — browsers throttle and silently DROP rapid programmatic
    // downloads, so firing one `<a download>` per ride loses most of a large
    // selection (e.g. a whole year). One archive is one reliable download.
    // In fetch-only (save === false) mode nothing is delivered, so we never retain
    // bytes here — important at the thousands-of-rides scale.
    const bundle: GpxFile[] = [];

    // In LIGHT mode, rides that already carry their route in the cache (Beeline-
    // sourced) can be exported entirely locally — no device, no network, no sign-in.
    // Split those out and synthesize their GPX from the stored track; only the rest
    // need the source. (This is why light GPX export works in the offline, cached-
    // rides mode.) In FULL mode every ride must be fetched from the cloud render,
    // EXCEPT rides whose full GPX we already downloaded once and cached on disk —
    // those are served straight from the gzip cache (instant, offline), so only the
    // rest hit the source.
    const remote: string[] = [];
    if (mode === "full") {
      for (const key of task.keys) {
        // Fetch-only: a ride already in the cache needs no work at all — count it
        // done without reading/gunzipping the blob.
        if (!save && this.gpxCache.has(key)) {
          succeeded++;
          if (task.progress) task.progress.done++;
          continue;
        }
        const file = save ? await this.buildCachedFullGpx(key) : null;
        if (file) {
          bundle.push(file);
          succeeded++;
          if (task.progress) task.progress.done++;
        } else {
          remote.push(key);
        }
      }
    } else {
      for (const key of task.keys) {
        const rec = this.store.rides.get(key);
        if (rec && rec.source === "beeline" && rec.track) {
          const file = this.buildCachedLightGpx(key);
          if (file) {
            bundle.push(file);
            succeeded++;
          } else {
            failures.push(`${rideShortLabel(key) || key}: no route track to export`);
          }
          if (task.progress) task.progress.done++;
        } else {
          remote.push(key);
        }
      }
    }

    // Only touch the source for rides that still need a real download (rides
    // without a cached full track). When every requested ride was handled locally,
    // we never call sourceFor() — so no spurious "Not connected" in a source-less
    // mode.
    if (remote.length) {
      const source = this.sourceFor();
      const files = await source.downloadGpx(
        new Set(remote),
        (msg) => report(msg),
        (file) => {
          // Keep only a rough, compressed sketch of the route in the cache — never the
          // full GPX. In full mode we ALSO parse the real track into the in-memory
          // session cache so the ride's map can use its real time + elevation at once.
          if (mode === "full") {
            try {
              this.fullTracks.set(
                file.key,
                extractFullTrack(new TextDecoder().decode(file.bytes)),
              );
            } catch {
              // A malformed GPX shouldn't sink the download; the rough sketch below
              // still drives the display map.
            }
            // Persist the full GPX (gzipped) so a later save/bundle of this ride is
            // instant and works offline. Fire-and-forget: caching is best-effort and
            // must never delay or fail the download itself (quota errors surface via
            // the cache's own onError). The bytes are only read, never mutated.
            void this.gpxCache.put(file.key, file.bytes).then((ok) => {
              if (ok) this.notify();
            });
          }
          const rough = gpxToRoughTrack(file.bytes, this.store.settings.trackPointsPerKm);
          if (rough.polyline) {
            this.store.upsert(file.key, {
              ...this.deviceFields(),
              track: rough.polyline,
              track_src_points: rough.srcPoints,
              track_points: rough.keptPoints,
              track_km: rough.km,
              track_bytes: file.bytes.length,
            });
            this.store.save();
            this.notify();
          } else {
            // We pulled the file but couldn't read a GPS track out of it. Don't store a
            // bogus empty track; record it so the task surfaces a real, persistent error.
            failures.push(`${file.key}: couldn't extract a GPS track from the downloaded GPX`);
          }
          // Only retain bytes for delivery when actually saving; fetch-only has
          // already cached them above and discards the bytes here.
          if (save) bundle.push(file);
          if (task.progress) task.progress.done++;
        },
        (missing) => {
          for (const key of missing) if (this.store.markDeleted(key)) removed++;
          if (removed) {
            this.store.save();
            this.notify();
          }
        },
        (key, reason, retryable) => {
          // When the full export gateway is unreachable but the ride still carries a
          // cached route, hand the user a route-only GPX instead of failing — so a
          // gateway outage mid-batch never breaks the download. Genuine "no track"
          // failures (not retryable) stay real errors. Skipped in fetch-only mode:
          // there's no file to hand over and a route-only sketch is nothing to cache,
          // so an unreachable full export is reported as a real failure instead.
          if (save && mode === "full" && retryable) {
            const fallback = this.buildCachedLightGpx(key);
            if (fallback) {
              bundle.push(fallback);
              succeeded++;
              degraded.push(rideShortLabel(key) || key);
              if (task.progress) task.progress.done++;
              return;
            }
          }
          failures.push(`${key}: ${reason}`);
        },
        // Capture the ride's detail read during the export so a GPX download on a
        // ride we never opened still records its title/stats/Strava status.
        (detail) => this.persistDetail(detail),
        mode,
      );
      succeeded += files.length;
    }

    // Deliver the produced files. One file → a plain GPX (unchanged behaviour); more
    // than one → a single ZIP so the browser reliably saves the whole batch. In
    // fetch-only mode nothing is delivered — the rides are now cached.
    let bundled = false;
    if (save && bundle.length === 1) {
      this.emitGpx(bundle[0]);
    } else if (save && bundle.length > 1) {
      const zipBytes = await buildZip(
        bundle.map((f) => ({ name: f.downloadName, bytes: f.bytes })),
      );
      const name = this.bundleZipName(bundle, mode);
      this.emitGpx({
        key: bundle[0].key,
        filename: name,
        downloadName: name,
        bytes: zipBytes,
        mime: "application/zip",
      });
      bundled = true;
    }

    const suffix = removed ? `, ${removed} deleted` : "";
    // Surface any graceful degradation (full track unreachable → route-only) in the
    // completion status so the user knows those files lack real time/elevation.
    const degradedNote = degraded.length
      ? ` — ${degraded.length} saved as route-only (export gateway unreachable; no real time/elevation)`
      : "";
    const bundleNote = bundled ? " (bundled into one .zip)" : "";
    report(
      save
        ? `exported ${succeeded} GPX file${succeeded === 1 ? "" : "s"}${bundleNote}${suffix}${degradedNote}`
        : `fetched & cached ${succeeded} full GPX${succeeded === 1 ? "" : "s"}${suffix}`,
    );

    if (failures.length) {
      // Fail the task so the UI shows a persistent, acknowledgeable error with full
      // per-ride detail under "Details" — not a status message that just blinks past.
      const verb = save ? "GPX download" : "GPX fetch";
      const header = `${failures.length} of ${task.keys.length} ${verb}${
        task.keys.length === 1 ? "" : "s"
      } failed (${succeeded} succeeded):`;
      throw new Error([header, ...failures.map((f) => `  • ${f}`)].join("\n"));
    }
  }

  /**
   * Name a multi-ride ZIP bundle: `Beeline routes 2026-01-03 to 2026-12-28 (123).zip`
   * (or `Beeline GPX …` in full mode). The date range is derived from the rides in
   * the bundle so the file is self-describing and sorts chronologically; it collapses
   * to a single date when every ride falls on the same day.
   */
  private bundleZipName(files: GpxFile[], mode: GpxMode): string {
    const kind = mode === "full" ? "GPX" : "routes";
    const dates = files
      .map((f) => rideDatetime(f.key))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    const p2 = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    let range = "";
    if (dates.length) {
      const lo = iso(dates[0]);
      const hi = iso(dates[dates.length - 1]);
      range = lo === hi ? ` ${lo}` : ` ${lo} to ${hi}`;
    }
    return `Beeline ${kind}${range} (${files.length}).zip`;
  }

  /**
   * Rename a ride on the backend, then mirror the new name locally. The cloud is
   * the source of truth (the name lives on the Beeline ride node); we only update
   * the cache once the write succeeds. The fuller `title` keeps any location suffix
   * the ride already carried, so only the user-facing name part changes.
   */
  private async doRename(task: Task, report: Report): Promise<void> {
    const key = task.keys[0];
    const newTitle = ((task.payload.title as string) ?? "").trim();
    if (!key) return;
    const source = this.sourceFor();
    const detail = await source.renameRide(key, newTitle, (msg) => report(msg));
    // Preserve any ", <place>" suffix the existing title carried beyond the base.
    const rec = this.store.rides.get(key);
    const suffix =
      rec && rec.title.startsWith(rec.title_base) && rec.title.length > rec.title_base.length
        ? rec.title.slice(rec.title_base.length)
        : "";
    this.store.upsert(key, {
      ...this.deviceFields(),
      title_base: detail.title,
      title: detail.title + suffix,
    });
    this.store.save();
    this.notify();
    report(`renamed to “${detail.title}”`);
  }

  /**
   * Delete a ride on the backend, then keep it locally as a tombstone (the existing
   * `deleted`/`deleted_at` state) rather than dropping it — so the row stays visible
   * as “deleted” and a later complete scan won't resurrect it (it's gone upstream).
   */
  private async doDelete(task: Task, report: Report): Promise<void> {
    const key = task.keys[0];
    if (!key) return;
    const source = this.sourceFor();
    await source.deleteRide(key, (msg) => report(msg));
    this.store.markDeleted(key);
    this.store.save();
    this.notify();
    report(`deleted ${rideShortLabel(key) || key}`);
  }

  // -- enqueue helpers / API surface ------------------------------------

  scan(preset: string, days: number | null): TaskSnapshotResult {
    const label = preset !== "custom" ? preset : `last ${days}d`;
    return this.jobs.submit("scan", { label, payload: { preset, days } });
  }

  upload(keys: string[], label = ""): TaskSnapshotResult {
    // Never re-upload a ride that's already on Strava: filter out uploaded keys at the
    // single choke point every caller funnels through (per-ride, selection, month, year,
    // all-pending), so no UI path can submit a duplicate upload.
    const fresh = keys.filter((k) => this.store.rides.get(k)?.strava_status !== "uploaded");
    return this.jobs.submit("upload", {
      label: label || `${fresh.length} rides`,
      keys: fresh,
    });
  }

  /** Export each given ride's route as a GPX file handed to the UI to write to disk.
   *  `mode` selects the lightweight stored-shape GPX (default, local) or the full
   *  recorded track fetched from the cloud (see `GpxMode`). */
  downloadGpx(keys: string[], label = "", mode: GpxMode = "light"): TaskSnapshotResult {
    return this.jobs.submit("download-gpx", {
      label: label || `${keys.length} rides`,
      keys,
      payload: { mode, save: true },
    });
  }

  /**
   * Fetch the FULL recorded GPX for the given rides and cache it locally WITHOUT
   * saving any file to disk. Same queued cloud sweep as a full download (it also
   * rehydrates each ride's real time/elevation map track), minus the delivery — so
   * the user can pre-warm the offline cache for a selection in one go. Rides already
   * cached are skipped. Runs as its own sweep: the `save:false` payload keeps it from
   * coalescing with a real save-download (see JobQueue).
   */
  fetchFullGpx(keys: string[], label = ""): TaskSnapshotResult {
    return this.jobs.submit("download-gpx", {
      label: label || `${keys.length} rides`,
      keys,
      payload: { mode: "full", save: false },
    });
  }

  /** Rename a ride (on the backend, then locally). One ride per task; not coalesced. */
  rename(key: string, newTitle: string): TaskSnapshotResult {
    return this.jobs.submit("rename", {
      label: rideShortLabel(key) || key,
      keys: [key],
      payload: { title: newTitle },
    });
  }

  /** Delete a ride (on the backend, then tombstoned locally). One ride per task. */
  deleteRide(key: string): TaskSnapshotResult {
    return this.jobs.submit("delete", {
      label: rideShortLabel(key) || key,
      keys: [key],
    });
  }

  /** Update the rough-track density (points/km, persisted). Returns the clamped value. */
  setTrackPointsPerKm(n: number): number {
    const v = this.store.setTrackPointsPerKm(n);
    this.notify();
    return v;
  }

  /** Update the average-speed outlier trim (slow/fast %, persisted). Returns the clamped pair. */
  setSpeedTrim(slowPct: number, fastPct: number): { slowPct: number; fastPct: number } {
    const v = this.store.setSpeedTrim(slowPct, fastPct);
    this.notify();
    return v;
  }

  /** Update the heatmap glow radius (px, persisted). Returns the clamped value. */
  setHeatRadius(n: number): number {
    const v = this.store.setHeatRadius(n);
    this.notify();
    return v;
  }

  /** Update how many Beeline uploads run at once (persisted). Returns the clamped value. */
  setBeelineUploadConcurrency(n: number): number {
    const v = this.store.setBeelineUploadConcurrency(n);
    this.notify();
    return v;
  }

  cancel(id: number | null): void {
    if (id === null) this.jobs.cancelAll();
    else this.jobs.cancel(id);
  }

  clear(): number {
    return this.jobs.clear();
  }

  /**
   * Wipe all local state: cancel/clear the job queue and empty the ride cache. Also
   * flushes the persistent full-GPX cache (a reset is "erase everything local").
   * Destroys browser-side data only; nothing in your Beeline account is affected.
   */
  reset(): void {
    this.jobs.cancelAll();
    this.jobs.clear();
    this.store.clear();
    void this.gpxCache.clear();
    this.notify();
  }

  /**
   * Flush ONLY the persistent full-GPX cache, leaving rides and settings intact.
   * Separate from `reset()` so the user can reclaim the (potentially large) GPX
   * cache without losing their ride history.
   */
  async flushGpxCache(): Promise<void> {
    await this.gpxCache.clear();
    this.notify();
  }

  /** Total on-disk (compressed) size of the cached full-GPX files, in bytes. */
  gpxCacheBytes(): number {
    return this.gpxCache.totalBytes();
  }

  /** Number of rides with a cached full GPX. */
  gpxCacheCount(): number {
    return this.gpxCache.count;
  }

  /** The set of ride keys whose full GPX is cached on disk. */
  gpxCachedKeys(): Set<string> {
    return this.gpxCache.cachedKeys();
  }

  // -- import / export ---------------------------------------------------

  /** Force any pending debounced cache write out now (e.g. before the page unloads). */
  flush(): Promise<void> {
    return this.store.flush();
  }

  exportJson(meta?: Record<string, unknown>): string {
    return this.store.exportJson(meta);
  }

  importJson(text: string): number {
    const n = this.store.importJson(text);
    this.notify();
    return n;
  }

  /** Byte size of the locally persisted state, for a human-readable size hint. */
  stateBytes(): number {
    return this.store.byteSize();
  }
}

// `submit` returns a task snapshot; alias keeps the surface readable.
type TaskSnapshotResult = ReturnType<JobQueue["submit"]>;

export { rideMonth };
