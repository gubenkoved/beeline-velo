/**
 * GPX Toolkit — unified single-thumb range slider behaviour.
 *
 * The `.uslider` class (in style.css) gives every single-thumb `<input type="range">`
 * one canonical look: a 4px track with an accent fill left of the thumb. WebKit has
 * no native "progress" fill, so the fill fraction is driven by a `--fill` custom
 * property that JS keeps in sync with the value (Firefox fills for free via
 * `::-moz-range-progress`, but we set `--fill` anyway — harmless there).
 *
 * This is the one canonical place that computes that fraction, so every slider —
 * Stats thickness, Wind/Speed trims + max-speed, Timeline heat tweaks + day
 * scrubber, Settings, the Windalytics hour — stays visually identical.
 */

/** Set the accent-fill fraction (`--fill`, 0–1) of one `.uslider` from its value. */
export function setSliderFill(el: HTMLInputElement): void {
  const min = Number(el.min);
  const max = Number(el.max);
  const span = max - min;
  const frac = span > 0 ? (Number(el.value) - min) / span : 0;
  el.style.setProperty("--fill", String(Math.min(1, Math.max(0, frac))));
}

/** Initialise the fill of every `.uslider` under `root` (call after a view mounts). */
export function initSliderFills(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLInputElement>("input[type='range'].uslider")
    .forEach(setSliderFill);
}
