/**
 * Shared styled date-picker popover — a small month calendar that floats above (or
 * below) a trigger button, replacing the unstylable native `<input type="date">`.
 *
 * One canonical implementation for every day-picker in the app: the Timeline view's
 * "jump to a day" control (a sparse set of days that actually have data) and the
 * Explore filter panel's ingestion-date from/to pickers (a continuous min..max
 * range). The popover owns its own DOM, positioning, and dismissal listeners, so a
 * caller just hands it an anchor + bounds + an `onPick` callback.
 *
 * Only one picker is open at a time (a single shared popover). Days are plain
 * `"YYYY-MM-DD"` strings throughout (timezone-free calendar days).
 */

const DOW = ["M", "T", "W", "T", "F", "S", "S"];

export interface DatePickerIcons {
  /** Inline SVG for the previous-month arrow. */
  chevLeft: string;
  /** Inline SVG for the next-month arrow. */
  chevRight: string;
}

export interface DatePickerOptions {
  /** The trigger element to position the popover against. */
  anchor: HTMLElement;
  /** Element to append the popover (and mobile backdrop) into. */
  parent: HTMLElement;
  /** Currently-selected day (`"YYYY-MM-DD"`), highlighted; opens on its month. */
  value?: string | null;
  /** Earliest selectable day (`"YYYY-MM-DD"`); days before it are disabled. */
  min?: string | null;
  /** Latest selectable day (`"YYYY-MM-DD"`); days after it are disabled. */
  max?: string | null;
  /** Optional sparse allow-list: when given, only these days are selectable (others
   *  are shown disabled) — for the Timeline's "days with data". Omit for a plain
   *  continuous min..max range. */
  allowedDays?: Set<string>;
  /** HTML escaper (injected so this module stays DOM-vocabulary-only). */
  esc: (s: string) => string;
  /** Chevron icons for the month nav. */
  icons: DatePickerIcons;
  /** Viewport width (px) at/below which the popover becomes a centered modal with a
   *  backdrop instead of being anchored to the trigger (default 768). */
  modalBelow?: number;
  /** Called with the picked `"YYYY-MM-DD"` day; the popover closes first. */
  onPick: (day: string) => void;
}

/** ISO `"YYYY-MM-DD"` for a year + 0-based month + day. */
function isoDay(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface OpenState {
  opts: DatePickerOptions;
  year: number;
  month: number; // 0-based
}

let state: OpenState | null = null;
let outside: ((e: PointerEvent) => void) | null = null;
let keydown: ((e: KeyboardEvent) => void) | null = null;

/** Open (or replace) the shared date-picker against `opts.anchor`. */
export function openDatePicker(opts: DatePickerOptions): void {
  // Base the visible month on the selected value, else the max bound, else today.
  const base = opts.value || opts.max || new Date().toISOString().slice(0, 10);
  const [y, m] = base.split("-").map(Number);
  state = { opts, year: y, month: m - 1 };
  render();
  // Defer wiring dismiss listeners so the opening click doesn't immediately close it.
  setTimeout(() => {
    if (!state) return;
    outside = (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest("#dpPop") && t !== state?.opts.anchor && !state?.opts.anchor.contains(t))
        closeDatePicker();
    };
    keydown = (e) => {
      if (e.key === "Escape" && state) {
        e.stopPropagation();
        closeDatePicker();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keydown, true);
  }, 0);
}

/** Close the shared date-picker (no-op when nothing is open). */
export function closeDatePicker(): void {
  state = null;
  document.getElementById("dpPop")?.remove();
  document.getElementById("dpBack")?.remove();
  if (outside) document.removeEventListener("pointerdown", outside, true);
  if (keydown) document.removeEventListener("keydown", keydown, true);
  outside = keydown = null;
}

/** Shift the visible month by `dir` (±1) within the [min,max] months, re-render. */
function navMonth(dir: number): void {
  if (!state) return;
  const d = new Date(Date.UTC(state.year, state.month + dir, 1));
  state.year = d.getUTCFullYear();
  state.month = d.getUTCMonth();
  render();
}

/** True below the modal breakpoint — render centered over a backdrop, not anchored. */
function isModal(o: DatePickerOptions): boolean {
  return window.matchMedia(`(max-width: ${o.modalBelow ?? 768}px)`).matches;
}

/** Build/refresh the popover for the month in `state` and position it. */
function render(): void {
  if (!state) return;
  const { opts, year, month } = state;
  const minDay = opts.min ?? null;
  const maxDay = opts.max ?? null;
  const curMonth = `${year}-${String(month + 1).padStart(2, "0")}`;
  const prevOff = minDay != null && curMonth <= minDay.slice(0, 7);
  const nextOff = maxDay != null && curMonth >= maxDay.slice(0, 7);
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const firstDow = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);

  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<span class="dp-cell empty"></span>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoDay(year, month, d);
    const outOfRange = (minDay != null && iso < minDay) || (maxDay != null && iso > maxDay);
    const disallowed = opts.allowedDays != null && !opts.allowedDays.has(iso);
    const out = outOfRange || disallowed;
    const sel = iso === opts.value;
    const cls = `dp-cell${sel ? " sel" : ""}${iso === today ? " today" : ""}`;
    cells += out
      ? `<span class="dp-cell out">${d}</span>`
      : `<button class="${cls}" data-dp="pick" data-day="${iso}">${d}</button>`;
  }

  let pop = document.getElementById("dpPop");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "dpPop";
    pop.className = "dp";
    pop.addEventListener("click", onPopClick);
    opts.parent.appendChild(pop);
  }
  pop.innerHTML =
    `<div class="dp-head">` +
    `<span class="dp-month">${opts.esc(monthLabel)}</span>` +
    `<span class="dp-nav">` +
    `<button class="dp-arrow" data-dp="nav" data-dir="-1" ${prevOff ? "disabled" : ""} aria-label="Previous month">${opts.icons.chevLeft}</button>` +
    `<button class="dp-arrow" data-dp="nav" data-dir="1" ${nextOff ? "disabled" : ""} aria-label="Next month">${opts.icons.chevRight}</button>` +
    `</span></div>` +
    `<div class="dp-grid dp-dow">${DOW.map((d) => `<span class="dp-cell dow">${d}</span>`).join("")}</div>` +
    `<div class="dp-grid">${cells}</div>`;

  // Phones: a centered modal over a backdrop (CSS centers it); clear any inline
  // coords left from a desktop render so they don't fight the centering rule.
  if (isModal(opts)) {
    pop.classList.add("dp--modal");
    pop.style.left = pop.style.top = "";
    pop.style.visibility = "visible";
    if (!document.getElementById("dpBack")) {
      const back = document.createElement("div");
      back.id = "dpBack";
      back.className = "dp-back";
      back.addEventListener("pointerdown", () => closeDatePicker());
      opts.parent.appendChild(back);
    }
    return;
  }
  pop.classList.remove("dp--modal");
  document.getElementById("dpBack")?.remove();

  // Desktop: position above the trigger; clamp within the viewport; drop below when
  // there isn't room above.
  pop.style.visibility = "hidden";
  pop.style.left = "0px";
  const a = opts.anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
  let top = a.top - h - 8;
  if (top < 8) top = a.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = "visible";
}

/** Delegated click handler for the popover (month nav + day pick). */
function onPopClick(e: Event): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-dp]");
  if (!el || !state) return;
  if (el.dataset.dp === "nav") {
    navMonth(Number(el.dataset.dir));
  } else if (el.dataset.dp === "pick" && el.dataset.day) {
    const day = el.dataset.day;
    const cb = state.opts.onPick;
    closeDatePicker();
    cb(day);
  }
}
