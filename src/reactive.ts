/**
 * GPX Toolkit — a tiny reactive core (signals + effects).
 *
 * Fine-grained, synchronous, dependency-free reactivity in ~50 lines. A `signal`
 * is a readable/writable value; reading one *inside* an `effect` subscribes that
 * effect, so it re-runs automatically when (and only when) a signal it actually
 * read changes. `computed` is a cached derived signal.
 *
 * This replaces hand-rolled "did anything change?" dirty-checking (the `lastSig`
 * comparison pattern): instead of one big re-render gated by manual signatures,
 * each view reads the signals it cares about and updates itself.
 *
 * Design notes:
 *  - Synchronous + glitch-tolerant-enough for UI: a `set` runs subscribers
 *    immediately. Effects clean up their old subscriptions before each run, so a
 *    conditional dependency that stops being read stops triggering re-runs.
 *  - No batching/scheduling: deliberately minimal. If a hot path needs batching,
 *    add it then — not now (keep it small).
 *  - Pure data layer: no DOM, no app state. Unit-tested in `tests/reactive.test.ts`.
 */

type EffectNode = { run: () => void; deps: Set<Set<EffectNode>> };

let activeEffect: EffectNode | null = null;

function track(subscribers: Set<EffectNode>): void {
  if (activeEffect) {
    subscribers.add(activeEffect);
    activeEffect.deps.add(subscribers);
  }
}

function runEffect(node: EffectNode): void {
  // Drop last run's subscriptions so stale (no-longer-read) signals can't wake us.
  for (const subs of node.deps) subs.delete(node);
  node.deps.clear();
  const prev = activeEffect;
  activeEffect = node;
  try {
    node.run();
  } finally {
    activeEffect = prev;
  }
}

export interface Signal<T> {
  /** Read the value (subscribes the current effect, if any). */
  (): T;
  /** Read without subscribing. */
  peek(): T;
  /** Set a new value (or update from the previous one); no-ops if unchanged. */
  set(next: T | ((prev: T) => T)): void;
}

/** A readable + writable reactive value. */
export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers = new Set<EffectNode>();

  const read = (() => {
    track(subscribers);
    return value;
  }) as Signal<T>;

  read.peek = () => value;

  read.set = (next: T | ((prev: T) => T)): void => {
    const v = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
    if (Object.is(v, value)) return;
    value = v;
    // Snapshot: a subscriber may re-subscribe (or unsubscribe) while running.
    for (const node of [...subscribers]) runEffect(node);
  };

  return read;
}

/**
 * Run `fn` now and re-run it whenever a signal it read changes. Returns a dispose
 * function that unsubscribes the effect.
 */
export function effect(fn: () => void): () => void {
  const node: EffectNode = { run: fn, deps: new Set() };
  runEffect(node);
  return () => {
    for (const subs of node.deps) subs.delete(node);
    node.deps.clear();
  };
}

/** A cached derived signal: recomputes only when its own dependencies change. */
export function computed<T>(fn: () => T): () => T {
  const out = signal<T>(undefined as unknown as T);
  effect(() => out.set(fn()));
  return () => out();
}
