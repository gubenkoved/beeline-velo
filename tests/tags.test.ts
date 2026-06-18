import { describe, expect, it } from "vitest";

import { addTag, collectTags, hasTag, normalizeTag, removeTag, tagKey } from "../src/tags";

describe("normalizeTag", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeTag("  Commute  ")).toBe("Commute");
    expect(normalizeTag("road   trip")).toBe("road trip");
    expect(normalizeTag("\tgravel\n")).toBe("gravel");
  });
  it("keeps the original casing", () => {
    expect(normalizeTag("BikePacking")).toBe("BikePacking");
  });
});

describe("tagKey (case-insensitive comparison key)", () => {
  it("lowercases the normalized display form", () => {
    expect(tagKey("Commute")).toBe("commute");
    expect(tagKey("  COMMUTE ")).toBe("commute");
    expect(tagKey("Road   Trip")).toBe("road trip");
  });
  it("treats differently-cased tags as the same key", () => {
    expect(tagKey("Gravel")).toBe(tagKey("gravel"));
  });
});

describe("addTag", () => {
  it("appends a new tag", () => {
    expect(addTag([], "Commute")).toEqual(["Commute"]);
    expect(addTag(["Commute"], "Gravel")).toEqual(["Commute", "Gravel"]);
  });
  it("dedupes case-insensitively, keeping the existing casing", () => {
    expect(addTag(["Commute"], "commute")).toEqual(["Commute"]);
    expect(addTag(["Commute"], "  COMMUTE ")).toEqual(["Commute"]);
  });
  it("ignores an empty/whitespace tag", () => {
    expect(addTag(["Commute"], "   ")).toEqual(["Commute"]);
  });
  it("normalizes the stored display form", () => {
    expect(addTag([], "  road   trip ")).toEqual(["road trip"]);
  });
});

describe("removeTag", () => {
  it("removes by case-insensitive key", () => {
    expect(removeTag(["Commute", "Gravel"], "commute")).toEqual(["Gravel"]);
    expect(removeTag(["Commute"], "  COMMUTE ")).toEqual([]);
  });
  it("is a no-op when the tag is absent", () => {
    expect(removeTag(["Commute"], "Gravel")).toEqual(["Commute"]);
  });
});

describe("hasTag", () => {
  it("matches case-insensitively", () => {
    expect(hasTag(["Commute"], "commute")).toBe(true);
    expect(hasTag(["Commute"], "Gravel")).toBe(false);
  });
});

describe("collectTags", () => {
  it("returns one entry per key, sorted by key, first-seen casing", () => {
    const rides = [
      { tags: ["Commute", "gravel"] },
      { tags: ["COMMUTE", "Road Trip"] },
      { tags: [] },
    ];
    expect(collectTags(rides)).toEqual(["Commute", "gravel", "Road Trip"]);
  });
  it("ignores blank tags", () => {
    expect(collectTags([{ tags: ["  ", "ok"] }])).toEqual(["ok"]);
  });
  it("is empty for untagged rides", () => {
    expect(collectTags([{ tags: [] }, { tags: [] }])).toEqual([]);
  });
});
