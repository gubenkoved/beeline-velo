import { describe, expect, it } from "vitest";

import { trimmedSpeed } from "../src/parsing";

/** Build a ride that covers `km` at a constant `kmh`. */
const ride = (km: number, kmh: number): { km: number; sec: number } => ({
  km,
  sec: (km / kmh) * 3600,
});

describe("trimmedSpeed", () => {
  it("returns the plain distance-weighted average with no trimming", () => {
    // 10 km @ 10 km/h (3600 s) + 10 km @ 30 km/h (1200 s) = 20 km / 4800 s = 15 km/h.
    const rides = [ride(10, 10), ride(10, 30)];
    expect(trimmedSpeed(rides, 0, 0)).toBeCloseTo(15, 6);
  });

  it("returns 0 for an empty set or rides without usable data", () => {
    expect(trimmedSpeed([], 0, 0)).toBe(0);
    expect(trimmedSpeed([{ km: 0, sec: 100 }, { km: 5, sec: 0 }], 0, 0)).toBe(0);
  });

  it("keeps a single ride's own speed regardless of trim %", () => {
    const rides = [ride(42, 23.5)];
    expect(trimmedSpeed(rides, 20, 20)).toBeCloseTo(23.5, 6);
    expect(trimmedSpeed(rides, 0, 40)).toBeCloseTo(23.5, 6);
  });

  it("drops the slowest distance from the low end", () => {
    // Four equal 10 km rides at 10/20/30/40 km/h. Trim slowest 25% of distance
    // (one whole ride @10) → remaining 30 km / (1200+1200+900 s? ) average.
    const rides = [ride(10, 10), ride(10, 20), ride(10, 30), ride(10, 40)];
    const all = trimmedSpeed(rides, 0, 0);
    const trimmed = trimmedSpeed(rides, 25, 0);
    expect(trimmed).toBeGreaterThan(all);
    // Kept rides: 10@20 (1800s) + 10@30 (1200s) + 10@40 (900s) = 30 km / 3900 s.
    expect(trimmed).toBeCloseTo(30 / (3900 / 3600), 6);
  });

  it("drops the fastest distance from the high end", () => {
    const rides = [ride(10, 10), ride(10, 20), ride(10, 30), ride(10, 40)];
    // Trim fastest 25% (the 40 km/h ride). Kept: 10@10 + 10@20 + 10@30.
    const trimmed = trimmedSpeed(rides, 0, 25);
    const sec = (10 / 10) * 3600 + (10 / 20) * 3600 + (10 / 30) * 3600;
    expect(trimmed).toBeCloseTo(30 / (sec / 3600), 6);
  });

  it("trims a boundary ride fractionally (by distance, preserving its speed)", () => {
    // Two 10 km rides; trim slowest 50% of distance = exactly the slow ride.
    const rides = [ride(10, 10), ride(10, 30)];
    expect(trimmedSpeed(rides, 50, 0)).toBeCloseTo(30, 6);
    // Trim slowest 25% = half of the slow ride remains alongside the fast one.
    // Kept: 5 km @10 (1800s) + 10 km @30 (1200s) = 15 km / 3000 s = 18 km/h.
    expect(trimmedSpeed(rides, 25, 0)).toBeCloseTo(15 / (3000 / 3600), 6);
  });

  it("returns 0 when the trim window collapses", () => {
    const rides = [ride(10, 10), ride(10, 30)];
    expect(trimmedSpeed(rides, 50, 50)).toBe(0);
    expect(trimmedSpeed(rides, 60, 50)).toBe(0);
  });
});
