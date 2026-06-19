/**
 * GPX Toolkit — pure number→string formatters.
 *
 * Dependency-free display helpers shared across every view (distance, speed,
 * duration, elevation, byte sizes). Extracted from `main.ts` so the per-view
 * modules can import them instead of reaching into the monolith. No state, no DOM.
 */

/** Whole hours-and-minutes label for a duration, e.g. "12h 30m" or "45m". */
export function fmtDuration(totalSec: number): string {
  const mins = Math.round(totalSec / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Exact "H:MM:SS" / "M:SS" for the per-ride detail grid (preserves seconds). */
export function fmtDurationExact(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Compact metres/kilometres label for an elevation total. */
export function fmtElevation(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}k m` : `${Math.round(m)} m`;
}

/** Human-readable size for the locally stored state (MB, with a KB step for tiny payloads). */
export function fmtBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} B`;
  const mb = kb / 1024;
  if (mb < 0.1) return `${Math.round(kb)} KB`;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

/** Distance label, e.g. "13 km" or "1.2k km". */
export function fmtKm(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k km` : `${Math.round(v)} km`;
}

/** Distance with one decimal (detail grid / row meta), e.g. "13.5 km". */
export function fmtKmDetail(v: number): string {
  return `${v.toFixed(1)} km`;
}

/** Speed label, e.g. "20.5 km/h". */
export function fmtSpeed(v: number): string {
  return `${v.toFixed(1)} km/h`;
}
