import { describe, expect, it } from "vitest";

import { computeStats, parseKm, parseMeters, type StatsRide } from "../src/stats";

/** Build a StatsRide with sane defaults so each test only sets what it cares about. */
function ride(partial: Partial<StatsRide> & { key: string }): StatsRide {
  return {
    distance: "",
    stats: {},
    track_km: 0,
    deleted: false,
    ...partial,
  };
}

describe("parseKm", () => {
  it("parses plain and thousands-separated kilometre strings", () => {
    expect(parseKm("42.5 km")).toBeCloseTo(42.5);
    expect(parseKm("1,234.5 km")).toBeCloseTo(1234.5);
  });
  it("returns 0 for missing or unrecognised input", () => {
    expect(parseKm("")).toBe(0);
    expect(parseKm("no distance")).toBe(0);
  });
});

describe("parseMeters", () => {
  it("parses metric elevation", () => {
    expect(parseMeters("1,234 m")).toBeCloseTo(1234);
    expect(parseMeters("250 m")).toBeCloseTo(250);
  });
  it("converts feet to metres", () => {
    expect(parseMeters("1000 ft")).toBeCloseTo(304.8);
    expect(parseMeters("500 feet")).toBeCloseTo(152.4);
  });
  it("assumes metres when no unit is given, and 0 when nothing parses", () => {
    expect(parseMeters("80")).toBeCloseTo(80);
    expect(parseMeters("")).toBe(0);
  });
});

describe("computeStats totals", () => {
  it("sums distance, moving time and elevation across rides", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance: "10 km", stats: { "Moving time": "0:30:00", "Elevation gain": "100 m" } }),
      ride({ key: "Tue Jun 2 2026 at 08:00", distance: "20 km", stats: { "Moving time": "1:00:00", "Elevation gain": "200 m" } }),
    ];
    const s = computeStats(rides);
    expect(s.rideCount).toBe(2);
    expect(s.totalKm).toBeCloseTo(30);
    expect(s.totalMovingSec).toBe(5400);
    expect(s.totalElevationM).toBeCloseTo(300);
  });

  it("prefers the detail 'Distance' stat, falls back to summary then track_km", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance: "9 km", stats: { Distance: "10 km" } }),
      ride({ key: "Tue Jun 2 2026 at 08:00", distance: "5 km" }),
      ride({ key: "Wed Jun 3 2026 at 08:00", track_km: 7 }),
    ];
    expect(computeStats(rides).totalKm).toBeCloseTo(22);
  });

  it("ignores deleted rides entirely", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance: "10 km" }),
      ride({ key: "Tue Jun 2 2026 at 08:00", distance: "99 km", deleted: true }),
    ];
    const s = computeStats(rides);
    expect(s.rideCount).toBe(1);
    expect(s.totalKm).toBeCloseTo(10);
  });

  it("returns empty-safe zeros and nulls for no rides", () => {
    const s = computeStats([]);
    expect(s).toEqual({
      rideCount: 0,
      totalKm: 0,
      totalMovingSec: 0,
      totalElevationM: 0,
      biggestRide: null,
      bestDay: null,
      bestWeek: null,
      bestMonth: null,
    });
  });
});

describe("computeStats records", () => {
  it("picks the single biggest ride by distance", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance: "10 km" }),
      ride({ key: "Tue Jun 2 2026 at 08:00", distance: "42 km" }),
      ride({ key: "Wed Jun 3 2026 at 08:00", distance: "30 km" }),
    ];
    const s = computeStats(rides);
    expect(s.biggestRide).toEqual({ key: "Tue Jun 2 2026 at 08:00", km: 42 });
  });

  it("sums distance per day and reports the best day", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance: "10 km" }),
      ride({ key: "Mon Jun 1 2026 at 18:00", distance: "15 km" }), // same day → 25 km
      ride({ key: "Tue Jun 2 2026 at 08:00", distance: "20 km" }),
    ];
    const s = computeStats(rides);
    expect(s.bestDay?.km).toBeCloseTo(25);
    expect(s.bestDay?.count).toBe(2);
  });

  it("aggregates a Monday-anchored week and a calendar month", () => {
    // Jun 8 2026 is a Monday; Jun 8 and Jun 14 fall in the same week.
    const rides = [
      ride({ key: "Mon Jun 8 2026 at 08:00", distance: "10 km" }),
      ride({ key: "Sun Jun 14 2026 at 08:00", distance: "12 km" }),
      ride({ key: "Mon Jun 22 2026 at 08:00", distance: "5 km" }),
    ];
    const s = computeStats(rides);
    expect(s.bestWeek?.km).toBeCloseTo(22); // the Jun 8–14 week
    expect(s.bestWeek?.count).toBe(2);
    expect(s.bestMonth?.km).toBeCloseTo(27); // all three are in June 2026
    expect(s.bestMonth?.count).toBe(3);
  });
});
