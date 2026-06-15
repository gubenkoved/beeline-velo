import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  autoGranularity,
  bucketRide,
  compareRideKeysDesc,
  isRideDetail,
  parseDurationSec,
  parseJourneysList,
  parseRideDetail,
  rideMonth,
  sinceFromPreset,
} from "../src/parsing";

const RECON = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "recon");
const read = (name: string): string => readFileSync(resolve(RECON, name), "utf-8");

describe("parseJourneysList", () => {
  it("extracts cards from a real launch dump", () => {
    const cards = parseJourneysList(read("01_launch.xml"));
    expect(cards.length).toBeGreaterThanOrEqual(6);
    const first = cards[0];
    expect(first.key).toBe("Sat Jun 13 2026 at 14:22");
    expect(first.title).toBe("Afternoon ride");
    expect(first.distance_km).toBeCloseTo(22.6);
    expect(first.elapsed_sec).toBe(5872);
    expect(first.tapY).toBeGreaterThan(0);
    const keys = cards.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ignores the off-column Heatmap header as a title", () => {
    const xml =
      '<?xml version="1.0"?><hierarchy>' +
      '<node text="Journeys" bounds="[42,214][308,291]"/>' +
      '<node text="Heatmap" bounds="[816,231][996,282]"/>' +
      '<node text="Sun May 17 2026 at 12:29" bounds="[240,349][583,386]"/>' +
      '<node text="2:15:26" bounds="[288,386][429,435]"/>' +
      '<node text="22.2km" bounds="[524,386][670,435]"/>' +
      "</hierarchy>";
    const cards = parseJourneysList(xml);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("");
    expect(cards[0].key).toBe("Sun May 17 2026 at 12:29");
    expect(cards[0].distance_km).toBeCloseTo(22.2);
  });

  it("uses a column-aligned title when present", () => {
    const xml =
      '<?xml version="1.0"?><hierarchy>' +
      '<node text="Heatmap" bounds="[816,231][996,282]"/>' +
      '<node text="Morning ride" bounds="[240,300][486,349]"/>' +
      '<node text="Sun May 17 2026 at 12:29" bounds="[240,349][583,386]"/>' +
      '<node text="2:15:26" bounds="[288,386][429,435]"/>' +
      '<node text="22.2km" bounds="[524,386][670,435]"/>' +
      "</hierarchy>";
    expect(parseJourneysList(xml)[0].title).toBe("Morning ride");
  });

  it("parses a real comma-decimal device dump (YAL-L21), keeping each card's own stats", () => {
    const cards = parseJourneysList(read("20_journeys_yal.xml"));
    const byKey = new Map(cards.map((c) => [c.key, c]));
    // The 08:45 ride's stats sit directly below its datetime — they must not be
    // mixed up with the next (08:24) card's stats.
    const ride = byKey.get("Fri May 30 2025 at 08:45");
    expect(ride).toBeDefined();
    expect(ride!.title).toBe("Morning ride");
    expect(ride!.elapsed_sec).toBe(1 * 3600 + 11 * 60 + 24);
    expect(ride!.distance_km).toBeCloseTo(13.5);
    const next = byKey.get("Fri May 30 2025 at 08:24");
    expect(next!.elapsed_sec).toBe(14 * 60 + 16);
    expect(next!.distance_km).toBeCloseTo(3.9);
  });
});

describe("parseRideDetail", () => {
  it("reads a pending ride with a Strava tap target", () => {
    const detail = parseRideDetail(read("14_ride_scrolled.xml"));
    expect(detail.stravaStatus).toBe("pending");
    expect(detail.stravaTap).not.toBeNull();
    expect(detail.stravaTap!.top).toBeLessThan(2200); // Strava sits above komoot
  });

  it("reads a processing ride", () => {
    expect(parseRideDetail(read("15_after_upload.xml")).stravaStatus).toBe("processing");
  });

  it("reads an uploaded ride", () => {
    const detail = parseRideDetail(read("16_uploaded.xml"));
    expect(detail.stravaStatus).toBe("uploaded");
    expect(detail.key).toBe("Sat Jun 13 2026 at 14:22");
  });

  it("parses the stats grid into normalized numbers", () => {
    const m = parseRideDetail(read("14_ride_scrolled.xml")).metrics;
    expect(m.distance_km).toBeCloseTo(22.6);
    expect(m.avg_speed_kmh).toBeCloseTo(20.0);
    expect(m.max_speed_kmh).toBeCloseTo(57.0);
    expect(m.moving_sec).toBe(1 * 3600 + 7 * 60 + 42);
    expect(m.elapsed_sec).toBe(1 * 3600 + 37 * 60 + 52);
    expect(m.elevation_gain_m).toBeCloseTo(25);
    expect(m.elevation_loss_m).toBeCloseTo(34);
  });

  it("pairs the stats grid on a real comma-decimal device dump (YAL-L21)", () => {
    const d = parseRideDetail(read("21_detail_yal.xml"));
    expect(d.key).toBe("Fri May 30 2025 at 08:45");
    expect(d.title).toBe("Morning ride, Kaatsheuvel");
    // Each value must pair with its own label, not a neighbouring stat's, and a
    // comma-decimal "13,5km" must normalize to 13.5 — emphatically not 135.
    expect(d.metrics.distance_km).toBeCloseTo(13.5);
    expect(d.metrics.avg_speed_kmh).toBeCloseTo(20.0);
    expect(d.metrics.max_speed_kmh).toBeCloseTo(33.4);
    expect(d.metrics.moving_sec).toBe(40 * 60 + 28);
    expect(d.metrics.elapsed_sec).toBe(1 * 3600 + 11 * 60 + 24);
    expect(d.metrics.elevation_gain_m).toBeCloseTo(209);
    expect(d.metrics.elevation_loss_m).toBeCloseTo(215);
  });

  it("never adopts a stat value as the title when the heading scrolls off (Check flow)", () => {
    // Real dump after revealActions() swiped the sheet up: the Strava button is
    // visible but the heading AND datetime are scrolled off the top, leaving a
    // stat value ("20,0km/h") as the top-most text. The title must stay empty
    // rather than become that stat, so the store keeps the previously-checked one.
    const d = parseRideDetail(read("22_detail_scrolled_yal.xml"));
    expect(d.title).toBe("");
    expect(d.stravaStatus).not.toBe("unknown"); // we did reach the upload button
    expect(d.metrics.avg_speed_kmh).toBeCloseTo(20.0);
  });
});

describe("isRideDetail", () => {
  it("detects a detail even when the upload buttons are below the fold", () => {
    // A freshly opened detail sheet: stat labels are on screen but the
    // Strava/komoot buttons are not yet revealed.
    const xml = read("02_ride_detail.xml");
    expect(parseRideDetail(xml).stravaStatus).toBe("unknown"); // no buttons visible
    expect(isRideDetail(xml)).toBe(true); // …yet we still know it's a detail
  });

  it("detects a revealed detail with action buttons", () => {
    expect(isRideDetail(read("16_uploaded.xml"))).toBe(true);
  });

  it("is false on the Journeys list", () => {
    expect(isRideDetail(read("01_launch.xml"))).toBe(false);
  });
});

describe("date helpers", () => {
  it("rideMonth", () => {
    expect(rideMonth("Sat Jun 13 2026 at 14:22")).toEqual(["2026-06", "June 2026"]);
    expect(rideMonth("Tue Jun 9 2026 at 18:29")).toEqual(["2026-06", "June 2026"]);
    expect(rideMonth("garbage")).toEqual(["0000-00", "Unknown"]);
  });

  it("parseDurationSec handles H:MM:SS, MM:SS and garbage", () => {
    expect(parseDurationSec("1:07:42")).toBe(4062);
    expect(parseDurationSec("59:30")).toBe(3570);
    expect(parseDurationSec("0:00")).toBe(0);
    expect(parseDurationSec("")).toBe(0);
    expect(parseDurationSec("garbage")).toBe(0);
    expect(parseDurationSec("12.5km")).toBe(0);
  });

  it("bucketRide groups by day/week/month/year", () => {
    const key = "Sat Jun 13 2026 at 14:22"; // a Saturday
    expect(bucketRide(key, "day")).toEqual(["2026-06-13", "Jun 13, 2026", "Jun 13"]);
    expect(bucketRide(key, "month")).toEqual(["2026-06", "June 2026", "Jun '26"]);
    expect(bucketRide(key, "year")).toEqual(["2026", "2026", "2026"]);
    // Week is Monday-anchored: Sat Jun 13 -> week of Mon Jun 8.
    expect(bucketRide(key, "week")).toEqual(["2026-06-08", "Week of Jun 8, 2026", "Jun 8"]);
  });

  it("bucketRide collapses unparseable keys into a trailing Unknown bucket", () => {
    const [sortKey, label] = bucketRide("garbage", "day");
    expect(label).toBe("Unknown");
    expect(sortKey > "2026-06-13").toBe(true); // sorts after real dates
  });

  it("autoGranularity picks resolution from the date span", () => {
    const day = (k: string): { key: string } => ({ key: k });
    // ~2 weeks -> day
    expect(
      autoGranularity([day("Mon Jun 1 2026 at 10:00"), day("Sat Jun 13 2026 at 14:22")]),
    ).toBe("day");
    // ~2 months -> week
    expect(
      autoGranularity([day("Wed Apr 15 2026 at 10:00"), day("Sat Jun 13 2026 at 14:22")]),
    ).toBe("week");
    // ~1.5 years -> month
    expect(
      autoGranularity([day("Sun Jan 1 2025 at 10:00"), day("Sat Jun 13 2026 at 14:22")]),
    ).toBe("month");
    // ~5 years -> year
    expect(
      autoGranularity([day("Mon Jan 1 2021 at 10:00"), day("Sat Jun 13 2026 at 14:22")]),
    ).toBe("year");
    // no parseable dates -> month
    expect(autoGranularity([day("garbage")])).toBe("month");
  });

  it("sinceFromPreset", () => {
    expect(sinceFromPreset("all")).toBeNull();
    const today = sinceFromPreset("today")!;
    expect(today.getHours()).toBe(0);
    expect(today.getMinutes()).toBe(0);
    const week = sinceFromPreset("week")!;
    expect(Math.abs(Date.now() - week.getTime() - 7 * 86400_000)).toBeLessThan(5000);
    const custom = sinceFromPreset("custom", 3)!;
    expect(Math.abs(Date.now() - custom.getTime() - 3 * 86400_000)).toBeLessThan(5000);
    expect(sinceFromPreset("custom")).toBeNull();
  });

  it("compareRideKeysDesc orders chronologically, not lexically", () => {
    // Real keys from the app — raw-string sort would mis-order these (weekday
    // prefix, "3" vs "13", and same-day rides by time).
    const keys = [
      "Wed Jun 3 2026 at 10:39",
      "Sat Jun 13 2026 at 14:22",
      "Sun Jun 7 2026 at 20:08",
      "Wed Jun 3 2026 at 19:04",
      "Tue Jun 9 2026 at 18:29",
      "Sun Jun 7 2026 at 13:28",
      "Tue Jun 9 2026 at 10:10",
    ];
    const sorted = [...keys].sort(compareRideKeysDesc);
    expect(sorted).toEqual([
      "Sat Jun 13 2026 at 14:22",
      "Tue Jun 9 2026 at 18:29",
      "Tue Jun 9 2026 at 10:10",
      "Sun Jun 7 2026 at 20:08",
      "Sun Jun 7 2026 at 13:28",
      "Wed Jun 3 2026 at 19:04",
      "Wed Jun 3 2026 at 10:39",
    ]);
  });
});
