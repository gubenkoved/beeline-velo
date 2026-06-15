/**
 * Local persistent state: which rides we know about and their Strava status.
 *
 * Originally a port of `beeline_uploader.store` (Python). The phone is
 * authoritative, but caching lets us list rides quickly and avoid re-opening every
 * ride on each run.
 *
 * Storage: a single serialized blob under one key in a KeyValueStore (IndexedDB
 * in production, an in-memory Map in demo/tests). Ride metrics are stored as
 * NORMALIZED numbers (distance_km, moving_sec, …; null = unknown) rather than the
 * localized phone strings the old schema (and the Python `rides.json`) kept; legacy
 * string blobs are migrated on load. The Python tool is no longer interop-compatible.
 */

import type { KeyValueStore } from "./kv";
import {
  looksLikeStat,
  metricsFromStatStrings,
  type RideMetrics,
  rideMonth,
  type StravaStatus,
} from "./parsing";

/** Key under which the single serialized cache blob is stored in the backend. */
export const STORAGE_KEY = "beeline-toolkit-state";

/** Where a ride's data originated. "" is the legacy value (ADB, pre-multi-source). */
export type RideSource = "" | "adb" | "beeline";

/** UTF-8 byte length of a string (so multi-byte ride titles count their real size). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Default rough-track density: points kept per kilometre of route. */
export const DEFAULT_TRACK_POINTS_PER_KM = 20;
const TRACK_MIN_POINTS_PER_KM = 1;
const TRACK_MAX_POINTS_PER_KM = 100;

function clampPointsPerKm(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TRACK_POINTS_PER_KM;
  return Math.max(TRACK_MIN_POINTS_PER_KM, Math.min(TRACK_MAX_POINTS_PER_KM, Math.round(n)));
}

/** Largest share of distance trimmable from a single (slow or fast) end of the speed view. */
export const SPEED_TRIM_MAX_PCT = 45;

/** Clamp one end's trim percentage into [0, SPEED_TRIM_MAX_PCT] (0 = no trimming). */
function clampTrimPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(SPEED_TRIM_MAX_PCT, Math.round(n)));
}

/** Default heatmap glow radius (px): the visual "thickness" of a rendered track. */
export const DEFAULT_HEAT_RADIUS = 12;
const HEAT_RADIUS_MIN = 2;
const HEAT_RADIUS_MAX = 30;

/** Clamp the heatmap glow radius into [HEAT_RADIUS_MIN, HEAT_RADIUS_MAX] px. */
function clampHeatRadius(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HEAT_RADIUS;
  return Math.max(HEAT_RADIUS_MIN, Math.min(HEAT_RADIUS_MAX, Math.round(n)));
}

/** Default number of Beeline Strava uploads to run concurrently. */
export const DEFAULT_BEELINE_CONCURRENCY = 4;
const BEELINE_CONCURRENCY_MIN = 1;
const BEELINE_CONCURRENCY_MAX = 8;

/** Clamp the Beeline upload concurrency into [MIN, MAX]. */
function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BEELINE_CONCURRENCY;
  return Math.max(BEELINE_CONCURRENCY_MIN, Math.min(BEELINE_CONCURRENCY_MAX, Math.round(n)));
}

export interface Settings {
  /** Points kept per kilometre when simplifying a downloaded GPX into a rough track. */
  trackPointsPerKm: number;
  /** Share of slowest distance (%) to drop from the average-speed view. */
  speedTrimSlowPct: number;
  /** Share of fastest distance (%) to drop from the average-speed view. */
  speedTrimFastPct: number;
  /** Heatmap glow radius (px) — how thick each track renders on the route-frequency map. */
  heatRadius: number;
  /** How many Beeline Strava uploads run at once (ADB uploads are always serial). */
  beelineUploadConcurrency: number;
}

function defaultSettings(): Settings {
  return {
    trackPointsPerKm: DEFAULT_TRACK_POINTS_PER_KM,
    speedTrimSlowPct: 0,
    speedTrimFastPct: 0,
    heatRadius: DEFAULT_HEAT_RADIUS,
    beelineUploadConcurrency: DEFAULT_BEELINE_CONCURRENCY,
  };
}

// UI chrome labels that must never be stored as a ride title.
const BAD_TITLES = new Set(["Heatmap", "Journeys", "Settings", "Ride"]);

/**
 * How long save() waits before writing, coalescing a burst of mutations (a slider
 * drag, a page of freshly-scanned rides) into a single durable write. Kept small
 * so at most this much work is ever at risk if the tab vanishes without a flush().
 */
const SAVE_DEBOUNCE_MS = 400;

function nowIso(): string {
  // ISO-8601 with seconds precision and a timezone offset, mirroring Python's
  // datetime.now(timezone.utc).isoformat(timespec="seconds").
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export interface RideRecord extends RideMetrics {
  key: string;
  /** Richest title seen (the detail-sheet heading, e.g. "Morning ride, Amstelveen"). */
  title: string;
  /** Short list-card name (e.g. "Morning ride"); the prefix of the fuller `title`. */
  title_base: string;
  strava_status: StravaStatus;
  /** Rough encoded-polyline sketch of the route (see track.ts). Empty when unknown. */
  track: string;
  /** Lat/lon points read from the downloaded GPX (0 when unknown). */
  track_src_points: number;
  /** Points kept in the rough track after simplification (0 when unknown). */
  track_points: number;
  /** Length of the source GPX track in kilometres (0 when unknown). */
  track_km: number;
  /** Size of the downloaded GPX file in bytes (0 when unknown). */
  track_bytes: number;
  /** Model of the phone this ride was last read from (e.g. "Pixel 10 Pro"). Empty when unknown. */
  device_model: string;
  /** USB serial of the phone this ride was last read from. Empty when unknown. */
  device_serial: string;
  /** Where this ride came from: "" (legacy/ADB), "adb", or "beeline". */
  source: RideSource;
  /** Source-native id: the Beeline push-id (needed for upload/status). "" for ADB. */
  source_id: string;
  last_seen: string;
  uploaded_at: string;
  /** True when the ride was known locally but has since vanished from the phone. */
  deleted: boolean;
  deleted_at: string;
}

function blankRecord(key: string): RideRecord {
  return {
    key,
    title: "",
    title_base: "",
    strava_status: "unknown",
    distance_km: null,
    moving_sec: null,
    elapsed_sec: null,
    avg_speed_kmh: null,
    max_speed_kmh: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
    track: "",
    track_src_points: 0,
    track_points: 0,
    track_km: 0,
    track_bytes: 0,
    device_model: "",
    device_serial: "",
    source: "",
    source_id: "",
    last_seen: "",
    uploaded_at: "",
    deleted: false,
    deleted_at: "",
  };
}

/** The numeric metric fields, used to detect already-normalized persisted records. */
const METRIC_KEYS: ReadonlyArray<keyof RideMetrics> = [
  "distance_km",
  "moving_sec",
  "elapsed_sec",
  "avg_speed_kmh",
  "max_speed_kmh",
  "elevation_gain_m",
  "elevation_loss_m",
];

/**
 * Derive normalized numeric metrics for a persisted ride, accepting BOTH the
 * current numeric shape and the legacy string shape (top-level `distance`/`duration`
 * plus a `stats` label→string map — the pre-normalization format, also produced by
 * the Python tool). Legacy strings are parsed once here via the canonical
 * locale-aware parsers; already-numeric records pass through. One-way + idempotent.
 */
function metricsFromPersisted(raw: Record<string, unknown>): RideMetrics {
  const isNumeric = METRIC_KEYS.some((k) => typeof raw[k] === "number");
  if (isNumeric) {
    const num = (k: keyof RideMetrics): number | null => {
      const v = raw[k];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    };
    return {
      distance_km: num("distance_km"),
      moving_sec: num("moving_sec"),
      elapsed_sec: num("elapsed_sec"),
      avg_speed_kmh: num("avg_speed_kmh"),
      max_speed_kmh: num("max_speed_kmh"),
      elevation_gain_m: num("elevation_gain_m"),
      elevation_loss_m: num("elevation_loss_m"),
    };
  }
  // Legacy: parse the `stats` map, folding the top-level summary strings in as
  // fallbacks for Distance / Elapsed time when the map lacked them.
  const stats =
    raw.stats && typeof raw.stats === "object" ? (raw.stats as Record<string, string>) : {};
  const distStr = typeof raw.distance === "string" ? raw.distance : "";
  const durStr = typeof raw.duration === "string" ? raw.duration : "";
  return metricsFromStatStrings({
    ...stats,
    Distance: stats.Distance || distStr,
    "Elapsed time": stats["Elapsed time"] || durStr,
  });
}

export function monthKey(rec: RideRecord): string {
  return rideMonth(rec.key)[0];
}

export function monthLabel(rec: RideRecord): string {
  return rideMonth(rec.key)[1];
}

interface Persisted {
  updated_at: string;
  settings: Settings;
  rides: Record<string, RideRecord>;
}

export interface UpsertFields extends Partial<RideMetrics> {
  title?: string;
  title_base?: string;
  strava_status?: StravaStatus;
  track?: string;
  track_src_points?: number;
  track_points?: number;
  track_km?: number;
  track_bytes?: number;
  device_model?: string;
  device_serial?: string;
  source?: RideSource;
  source_id?: string;
}

export class Store {
  rides: Map<string, RideRecord> = new Map();
  settings: Settings = defaultSettings();

  /** Pending-write state for the debounced write-back (see save()/flush()). */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  /** Byte size of the last serialized payload, surfaced to the UI as a size hint.
   * Cached so reads (byteSize()) stay O(1) on every render — never re-serialized
   * per frame. Refreshed only on the rare, costly events: load, write, import, clear. */
  private cachedBytes = 0;

  /**
   * @param backend durable key/value store (IndexedDB in production).
   * @param onError surfaced when a background write fails (e.g. quota exceeded).
   * @param storageKey backend key for this profile's blob (lets ADB/Beeline/demo
   *        keep separate, non-colliding caches). Defaults to the legacy key so the
   *        existing single-profile data keeps loading unchanged.
   */
  constructor(
    private readonly backend: KeyValueStore,
    private readonly onError?: (message: string) => void,
    private readonly storageKey: string = STORAGE_KEY,
  ) {
    // Seed the size hint for stores built directly (e.g. demo mode); Store.load()
    // refreshes again after ingesting any persisted payload.
    this.refreshSize();
  }

  static async load(
    backend: KeyValueStore,
    onError?: (message: string) => void,
    storageKey: string = STORAGE_KEY,
  ): Promise<Store> {
    const store = new Store(backend, onError, storageKey);
    let raw: string | null = null;
    try {
      raw = await backend.get(storageKey);
    } catch {
      /* storage unavailable — start empty */
    }
    if (raw) {
      try {
        store.ingest(JSON.parse(raw));
      } catch {
        /* corrupt cache — start fresh */
      }
    }
    store.refreshSize();
    return store;
  }

  /** Merge a persisted payload (from storage or an imported file) into memory. */
  private ingest(data: unknown): void {
    const settings = (data as Partial<Persisted>)?.settings;
    if (settings && typeof settings === "object") {
      if ("trackPointsPerKm" in settings) {
        this.settings.trackPointsPerKm = clampPointsPerKm(Number(settings.trackPointsPerKm));
      }
      if ("speedTrimSlowPct" in settings) {
        this.settings.speedTrimSlowPct = clampTrimPct(Number(settings.speedTrimSlowPct));
      }
      if ("speedTrimFastPct" in settings) {
        this.settings.speedTrimFastPct = clampTrimPct(Number(settings.speedTrimFastPct));
      }
      if ("heatRadius" in settings) {
        this.settings.heatRadius = clampHeatRadius(Number(settings.heatRadius));
      }
      if ("beelineUploadConcurrency" in settings) {
        this.settings.beelineUploadConcurrency = clampConcurrency(
          Number(settings.beelineUploadConcurrency),
        );
      }
    }
    const rides = (data as Partial<Persisted>)?.rides;
    if (!rides || typeof rides !== "object") return;
    for (const [key, raw] of Object.entries(
      rides as unknown as Record<string, Record<string, unknown>>,
    )) {
      const rec: RideRecord = { ...blankRecord(key), ...(raw as Partial<RideRecord>), key };
      // Normalize numeric metrics from EITHER the current numeric shape or the
      // legacy string shape, then drop any legacy string fields the spread carried
      // over so they never linger in the re-serialized blob.
      Object.assign(rec, metricsFromPersisted(raw));
      const legacy = rec as unknown as Record<string, unknown>;
      delete legacy.distance;
      delete legacy.duration;
      delete legacy.stats;
      // Scrub stale mis-parsed titles: UI chrome (Heatmap/Journeys/…) and stat
      // values/labels (e.g. "20,0km/h" captured when the detail heading scrolled
      // off-screen during a Check). Clearing lets the next scan/check reseed a
      // correct title instead of persisting the bad one forever.
      if (BAD_TITLES.has(rec.title) || looksLikeStat(rec.title)) rec.title = "";
      if (BAD_TITLES.has(rec.title_base) || looksLikeStat(rec.title_base)) rec.title_base = "";
      if (typeof rec.track !== "string") rec.track = "";
      rec.track_src_points = Number(rec.track_src_points) || 0;
      rec.track_points = Number(rec.track_points) || 0;
      rec.track_km = Number(rec.track_km) || 0;
      rec.track_bytes = Number(rec.track_bytes) || 0;
      if (typeof rec.device_model !== "string") rec.device_model = "";
      if (typeof rec.device_serial !== "string") rec.device_serial = "";
      rec.source = rec.source === "adb" || rec.source === "beeline" ? rec.source : "";
      if (typeof rec.source_id !== "string") rec.source_id = "";
      rec.deleted = rec.deleted === true; // coerce missing/odd values to a real boolean
      this.rides.set(key, rec);
    }
  }

  private serialize(): Persisted {
    const rides: Record<string, RideRecord> = {};
    for (const [k, v] of this.rides) rides[k] = v;
    return { updated_at: nowIso(), settings: { ...this.settings }, rides };
  }

  /**
   * Persist the in-memory cache. The Map is already the source of truth, so this
   * never blocks the UI: it marks the cache dirty and schedules a single debounced
   * background write, coalescing rapid bursts (slider drags, scan pages) into one.
   * Use flush() to force the pending write out immediately (e.g. before unload).
   */
  save(): void {
    this.dirty = true;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writePending();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Force any pending debounced write to happen now; resolves once it settles (or
   * immediately if nothing is pending). Call before the page unloads so the last
   * mutation isn't lost in the debounce window.
   */
  flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.writePending();
  }

  /**
   * Serialize and write the cache if dirty. Serialization is deferred to here (not
   * to each save() call) so a coalesced burst also pays the JSON cost only once. A
   * failed write — most likely a full disk/quota — is surfaced via `onError`.
   */
  private writePending(): Promise<void> {
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    const payload = JSON.stringify(this.serialize());
    this.cachedBytes = byteLength(payload);
    return this.backend.set(this.storageKey, payload).catch((err: unknown) => {
      const full = err instanceof DOMException && err.name === "QuotaExceededError";
      this.onError?.(
        full
          ? "Storage full — some ride data could not be saved locally."
          : "Failed to save ride data locally.",
      );
    });
  }

  upsert(key: string, fields: UpsertFields = {}): RideRecord {
    const rec = this.rides.get(key) ?? blankRecord(key);
    if (fields.title) rec.title = fields.title;
    if (fields.title_base) {
      rec.title_base = fields.title_base;
      // Seed the display title from the scan name until a fuller one is checked.
      if (!rec.title) rec.title = fields.title_base;
    }
    // Numeric metrics: only overwrite when the incoming figure is known (non-null),
    // so a later partial update (e.g. a list scan that only knows distance) never
    // clears a richer value an earlier Check already captured.
    if (fields.distance_km != null) rec.distance_km = fields.distance_km;
    if (fields.moving_sec != null) rec.moving_sec = fields.moving_sec;
    if (fields.elapsed_sec != null) rec.elapsed_sec = fields.elapsed_sec;
    if (fields.avg_speed_kmh != null) rec.avg_speed_kmh = fields.avg_speed_kmh;
    if (fields.max_speed_kmh != null) rec.max_speed_kmh = fields.max_speed_kmh;
    if (fields.elevation_gain_m != null) rec.elevation_gain_m = fields.elevation_gain_m;
    if (fields.elevation_loss_m != null) rec.elevation_loss_m = fields.elevation_loss_m;
    if (fields.track) rec.track = fields.track;
    if (fields.track_src_points != null) rec.track_src_points = fields.track_src_points;
    if (fields.track_points != null) rec.track_points = fields.track_points;
    if (fields.track_km != null) rec.track_km = fields.track_km;
    if (fields.track_bytes != null) rec.track_bytes = fields.track_bytes;
    if (fields.device_model) rec.device_model = fields.device_model;
    if (fields.device_serial) rec.device_serial = fields.device_serial;
    if (fields.source) rec.source = fields.source;
    if (fields.source_id) rec.source_id = fields.source_id;
    if (fields.strava_status && fields.strava_status !== "unknown") {
      if (fields.strava_status === "uploaded" && rec.strava_status !== "uploaded") {
        rec.uploaded_at = nowIso();
      }
      rec.strava_status = fields.strava_status;
    }
    // Seeing a ride again means it is NOT deleted (clear any stale flag).
    rec.deleted = false;
    rec.deleted_at = "";
    rec.last_seen = nowIso();
    this.rides.set(key, rec);
    return rec;
  }

  /**
   * Flag a known ride as deleted on the phone. No-op for unknown keys or rides
   * already flagged (so `deleted_at` records the first time we noticed). Returns
   * true when this call newly flagged the ride.
   */
  markDeleted(key: string): boolean {
    const rec = this.rides.get(key);
    if (!rec || rec.deleted) return false;
    rec.deleted = true;
    rec.deleted_at = nowIso();
    this.rides.set(key, rec);
    return true;
  }

  pending(): RideRecord[] {
    return [...this.rides.values()].filter((r) => r.strava_status === "pending" && !r.deleted);
  }

  /** Update the rough-track density (points/km) and persist. Returns the clamped value. */
  setTrackPointsPerKm(n: number): number {
    this.settings.trackPointsPerKm = clampPointsPerKm(n);
    this.save();
    return this.settings.trackPointsPerKm;
  }

  /** Update the average-speed outlier trim (slow/fast %) and persist. Returns the clamped pair. */
  setSpeedTrim(slowPct: number, fastPct: number): { slowPct: number; fastPct: number } {
    this.settings.speedTrimSlowPct = clampTrimPct(slowPct);
    this.settings.speedTrimFastPct = clampTrimPct(fastPct);
    this.save();
    return {
      slowPct: this.settings.speedTrimSlowPct,
      fastPct: this.settings.speedTrimFastPct,
    };
  }

  /** Update the heatmap glow radius (px) and persist. Returns the clamped value. */
  setHeatRadius(n: number): number {
    this.settings.heatRadius = clampHeatRadius(n);
    this.save();
    return this.settings.heatRadius;
  }

  /** Update the Beeline upload concurrency and persist. Returns the clamped value. */
  setBeelineUploadConcurrency(n: number): number {
    this.settings.beelineUploadConcurrency = clampConcurrency(n);
    this.save();
    return this.settings.beelineUploadConcurrency;
  }

  /**
   * Wipe all cached rides and restore default settings, removing the persisted
   * payload from storage. Local browser state only — this never touches the phone.
   */
  clear(): void {
    this.rides.clear();
    this.settings = defaultSettings();
    // Drop any pending debounced write so it can't resurrect the just-cleared data.
    this.dirty = false;
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.backend.del(this.storageKey).catch(() => {
      /* storage unavailable — non-fatal, the in-memory state is already cleared */
    });
    this.refreshSize();
  }

  /** Recompute the cached payload size from the current in-memory state. */
  private refreshSize(): void {
    this.cachedBytes = byteLength(JSON.stringify(this.serialize()));
  }

  /** Byte size of the persisted payload (UTF-8), for a human-readable size hint. */
  byteSize(): number {
    return this.cachedBytes;
  }

  // -- import / export ---------------------------------------------------

  /**
   * Serialized JSON of the whole cache (settings + rides) for download. An optional
   * `meta` object is merged at the top of the file — the UI passes the app
   * version/commit/build so an exported state records which build produced it. The
   * persisted IndexedDB blob never carries `meta`; it lives only in the download.
   */
  exportJson(meta?: Record<string, unknown>): string {
    return JSON.stringify({ ...meta, ...this.serialize() }, null, 2);
  }

  /** Merge an exported state JSON into the store and persist. Returns count merged. */
  importJson(text: string): number {
    const before = this.rides.size;
    this.ingest(JSON.parse(text));
    this.save();
    this.refreshSize();
    return this.rides.size - before;
  }
}
