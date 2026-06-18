import { describe, expect, it } from "vitest";

import type { CellDayWind } from "../src/weather";
import {
  aggregateRose,
  CALM_KMH,
  dirLabel,
  flattenSamples,
  localOffsetHours,
  monthlyRoses,
  roseFromSamples,
  roseMaxSector,
  sectorFractions,
  sectorIndex,
  speedBinIndex,
  type WindSample,
} from "../src/windrose";

/** Build a cell-day with 24 hourly (speed, dir) readings from per-hour generators. */
function cellDay(
  dayISO: string,
  speed: (h: number) => number | null,
  dir: (h: number) => number | null,
): CellDayWind {
  const spd: (number | null)[] = [];
  const wdir: (number | null)[] = [];
  for (let h = 0; h < 24; h++) {
    spd.push(speed(h));
    wdir.push(dir(h));
  }
  return {
    dataset: "era5",
    latIdx: 0,
    lonIdx: 0,
    cellLat: 0,
    cellLon: 0,
    gridKm: 25,
    dayISO,
    step: 24,
    hourly: { wind_speed_10m: spd, wind_direction_10m: wdir },
  };
}

describe("sectorIndex", () => {
  it("maps cardinal/intercardinal FROM-directions to the right sector", () => {
    expect(sectorIndex(0)).toBe(0); // N
    expect(sectorIndex(90)).toBe(4); // E
    expect(sectorIndex(180)).toBe(8); // S
    expect(sectorIndex(270)).toBe(12); // W
    expect(sectorIndex(45)).toBe(2); // NE
  });

  it("wraps the seam around North (350° and 10° both read ~N)", () => {
    expect(sectorIndex(355)).toBe(0);
    expect(sectorIndex(5)).toBe(0);
    expect(sectorIndex(-5)).toBe(0); // negative normalizes
    expect(sectorIndex(365)).toBe(0); // over 360 normalizes
  });

  it("labels match the sector", () => {
    expect(dirLabel(0)).toBe("N");
    expect(dirLabel(270)).toBe("W");
    expect(dirLabel(247.5)).toBe("WSW");
  });
});

describe("speedBinIndex", () => {
  it("bins on the lower-edge boundaries with an open top bin", () => {
    expect(speedBinIndex(0)).toBe(0);
    expect(speedBinIndex(4.9)).toBe(0);
    expect(speedBinIndex(5)).toBe(1);
    expect(speedBinIndex(12)).toBe(2);
    expect(speedBinIndex(25)).toBe(4);
    expect(speedBinIndex(30)).toBe(5);
    expect(speedBinIndex(120)).toBe(5);
  });
});

describe("localOffsetHours", () => {
  it("approximates a timezone offset from longitude", () => {
    expect(localOffsetHours(0)).toBe(0);
    expect(localOffsetHours(15)).toBe(1);
    expect(localOffsetHours(-120)).toBe(-8);
    expect(localOffsetHours(13)).toBe(1); // Berlin-ish ≈ +1
  });
});

describe("flattenSamples", () => {
  it("emits one sample per valid hour and shifts to local time", () => {
    // Longitude 30 → +2h offset. A UTC reading at 00:00 becomes local 02:00.
    const day = cellDay(
      "2024-06-15",
      () => 10,
      () => 90,
    );
    const s = flattenSamples([day], 30);
    expect(s).toHaveLength(24);
    const midnight = s.find((x) => x.ms === Date.UTC(2024, 5, 15, 0));
    expect(midnight?.hour).toBe(2);
    expect(midnight?.month).toBe(6);
    expect(midnight?.fromDeg).toBe(90);
  });

  it("re-attributes the day/month when the local shift crosses midnight", () => {
    // Longitude 30 → +2h. 23:00 UTC on the last day of June → 01:00 local on July 1.
    const day = cellDay(
      "2024-06-30",
      () => 10,
      () => 0,
    );
    const s = flattenSamples([day], 30);
    const late = s.find((x) => x.ms === Date.UTC(2024, 5, 30, 23));
    expect(late?.hour).toBe(1);
    expect(late?.month).toBe(7); // rolled into July locally
  });

  it("skips noData days and null hourly readings", () => {
    const good = cellDay(
      "2024-06-15",
      (h) => (h % 2 === 0 ? 10 : null),
      () => 45,
    );
    const bad: CellDayWind = {
      ...cellDay(
        "2024-06-16",
        () => 10,
        () => 45,
      ),
      noData: true,
    };
    const s = flattenSamples([good, bad], 0);
    expect(s).toHaveLength(12); // only the even hours of the good day
  });

  it("clips to a UTC time window", () => {
    const a = cellDay(
      "2024-01-01",
      () => 10,
      () => 0,
    );
    const b = cellDay(
      "2024-12-31",
      () => 10,
      () => 0,
    );
    const all = flattenSamples([a, b], 0);
    expect(all).toHaveLength(48);
    const clipped = flattenSamples([a, b], 0, Date.UTC(2024, 5, 1));
    expect(clipped).toHaveLength(24); // only December survives the min cutoff
  });
});

describe("roseFromSamples", () => {
  const sample = (over: Partial<WindSample>): WindSample => ({
    ms: 0,
    hour: 12,
    month: 6,
    year: 2024,
    fromDeg: 0,
    speedKmh: 10,
    ...over,
  });

  it("counts directional samples into sector × speed bins", () => {
    const samples = [
      sample({ fromDeg: 0, speedKmh: 7 }), // N, 5–10 bin (idx 1)
      sample({ fromDeg: 90, speedKmh: 12 }), // E, 10–15 bin (idx 2)
      sample({ fromDeg: 90, speedKmh: 13 }), // E, 10–15 bin (idx 2)
    ];
    const rose = roseFromSamples(samples, { hour: "all" });
    expect(rose.n).toBe(3);
    expect(rose.total).toBe(3);
    expect(rose.calm).toBe(0);
    expect(rose.counts[0][1]).toBe(1); // one N in the 5–10 bin
    expect(rose.counts[4][2]).toBe(2); // two E in the 10–15 bin
  });

  it("separates calm from the directional sectors", () => {
    const samples = [
      sample({ fromDeg: 0, speedKmh: 0.2 }), // calm
      sample({ fromDeg: 0, speedKmh: 10 }),
    ];
    const rose = roseFromSamples(samples, { hour: "all" });
    expect(rose.calm).toBe(1);
    expect(rose.total).toBe(1);
    expect(rose.n).toBe(2);
    expect(CALM_KMH).toBe(1);
  });

  it("filters by hour and by month", () => {
    const samples = [
      sample({ hour: 9, month: 1, fromDeg: 0 }),
      sample({ hour: 14, month: 1, fromDeg: 90 }),
      sample({ hour: 14, month: 7, fromDeg: 180 }),
    ];
    const byHour = roseFromSamples(samples, { hour: 14 });
    expect(byHour.total).toBe(2);
    const byHourMonth = roseFromSamples(samples, { hour: 14, months: new Set([1]) });
    expect(byHourMonth.total).toBe(1);
    expect(byHourMonth.counts[4][2]).toBe(1); // E sector, speed 10 → 10–15 bin (idx 2)
  });

  it("computes a vector-mean resultant that survives the 350°→10° wrap", () => {
    // Winds from ~due North, split either side of the 0° seam, should average to ~N.
    const samples = [
      sample({ fromDeg: 350, speedKmh: 10 }),
      sample({ fromDeg: 10, speedKmh: 10 }),
    ];
    const rose = roseFromSamples(samples, { hour: "all" });
    // Resultant direction ≈ 0° (North), not ~180° a naive scalar mean would give.
    const d = rose.meanVector.fromDeg;
    expect(Math.min(d, 360 - d)).toBeLessThan(1);
    expect(rose.meanVector.speedKmh).toBeCloseTo(10 * Math.cos(10 * (Math.PI / 180)), 3);
    expect(rose.meanSpeedKmh).toBeCloseTo(10, 6);
  });

  it("is empty-safe", () => {
    const rose = roseFromSamples([], { hour: "all" });
    expect(rose.n).toBe(0);
    expect(rose.total).toBe(0);
    expect(rose.meanVector.speedKmh).toBe(0);
    expect(roseMaxSector(rose)).toBe(0);
    expect(sectorFractions(rose).every((v) => v === 0)).toBe(true);
  });
});

describe("monthlyRoses + sectorFractions", () => {
  it("produces 12 month roses and normalized direction fractions", () => {
    const day = cellDay(
      "2024-06-15",
      () => 10,
      () => 90,
    ); // all due-East, June
    const samples = flattenSamples([day], 0);
    const months = monthlyRoses(samples, "all");
    expect(months).toHaveLength(12);
    expect(months[5].total).toBe(24); // June (index 5) has all 24 hours
    expect(months[0].total).toBe(0); // January empty
    const fr = sectorFractions(months[5]);
    expect(fr[4]).toBeCloseTo(1, 6); // all energy in the E sector
    expect(fr.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe("aggregateRose", () => {
  it("flattens and aggregates in one call", () => {
    const day = cellDay(
      "2024-06-15",
      () => 8,
      () => 270,
    ); // due-West
    const rose = aggregateRose([day], { hour: "all", lon: 0 });
    expect(rose.total).toBe(24);
    expect(roseMaxSector(rose)).toBe(24);
    expect(rose.counts[12][1]).toBe(24); // W sector, 5–10 bin
  });
});
