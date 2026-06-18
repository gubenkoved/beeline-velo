import { describe, expect, it, vi } from "vitest";

import { computed, effect, signal } from "../src/reactive";

describe("signal", () => {
  it("reads and writes a value", () => {
    const s = signal(1);
    expect(s()).toBe(1);
    s.set(2);
    expect(s()).toBe(2);
  });

  it("supports an updater function", () => {
    const s = signal(10);
    s.set((p) => p + 5);
    expect(s()).toBe(15);
  });

  it("peek() reads without subscribing", () => {
    const s = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy(s.peek());
    });
    expect(spy).toHaveBeenCalledTimes(1);
    s.set(1);
    expect(spy).toHaveBeenCalledTimes(1); // peek did not subscribe
  });
});

describe("effect", () => {
  it("runs immediately and re-runs when a read signal changes", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => seen.push(s()));
    expect(seen).toEqual([0]);
    s.set(1);
    s.set(2);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("does NOT re-run when an unrelated signal changes", () => {
    const a = signal(0);
    const b = signal(0);
    const spy = vi.fn();
    effect(() => {
      a();
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    b.set(1);
    expect(spy).toHaveBeenCalledTimes(1);
    a.set(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("skips a no-op set (Object.is equal)", () => {
    const s = signal(5);
    const spy = vi.fn();
    effect(() => {
      s();
      spy();
    });
    s.set(5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("tracks conditional dependencies — drops stale ones", () => {
    const toggle = signal(true);
    const a = signal("a");
    const b = signal("b");
    const seen: string[] = [];
    effect(() => seen.push(toggle() ? a() : b()));
    expect(seen).toEqual(["a"]);
    // While toggle=true we read `a`, not `b`: changing b must not re-run.
    b.set("b2");
    expect(seen).toEqual(["a"]);
    // Flip to read `b`; now `a` should no longer wake us.
    toggle.set(false);
    expect(seen).toEqual(["a", "b2"]);
    a.set("a2");
    expect(seen).toEqual(["a", "b2"]);
    b.set("b3");
    expect(seen).toEqual(["a", "b2", "b3"]);
  });

  it("dispose() stops further runs", () => {
    const s = signal(0);
    const spy = vi.fn();
    const stop = effect(() => {
      s();
      spy();
    });
    s.set(1);
    expect(spy).toHaveBeenCalledTimes(2);
    stop();
    s.set(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("computed", () => {
  it("derives and caches, recomputing on dependency change", () => {
    const a = signal(2);
    const b = signal(3);
    const sum = computed(() => a() + b());
    expect(sum()).toBe(5);
    a.set(10);
    expect(sum()).toBe(13);
  });

  it("a computed can feed an effect", () => {
    const n = signal(1);
    const double = computed(() => n() * 2);
    const seen: number[] = [];
    effect(() => seen.push(double()));
    expect(seen).toEqual([2]);
    n.set(4);
    expect(seen).toEqual([2, 8]);
  });
});
