import { describe, expect, it, vi } from "vitest";

// Force the rough-track extraction to fail for every downloaded GPX, simulating a
// file we pulled successfully but couldn't read a GPS track out of. The controller
// must surface this as a real, persistent error rather than silently swallowing it.
vi.mock("../src/track", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/track")>();
  return { ...actual, gpxToRoughPolyline: () => "" };
});

import { DemoAdb } from "../src/adb/demo";
import type { AdbDevice } from "../src/adb/types";
import { Controller } from "../src/controller";
import { Store } from "../src/store";

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

function makeController(device: AdbDevice): Controller {
  return new Controller(async () => device, new Store(memStorage()), async () => {});
}

describe("download-gpx surfaces extraction failures", () => {
  it("fails the task with a descriptive error when no track can be extracted", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = "Sat Jun 13 2026 at 14:22";
    c.downloadGpx([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const errored = c.state().jobs.history.find((t) => t.kind === "download-gpx");
    expect(errored).toBeDefined();
    expect(errored!.status).toBe("error");
    expect(errored!.error).toContain("couldn't extract a GPS track");
    expect(errored!.error).toContain(key);

    // The ride must not be left with a bogus (empty) track.
    const rec = c.state().rides.find((r) => r.key === key)!;
    expect(rec.track).toBe("");
  });
});
