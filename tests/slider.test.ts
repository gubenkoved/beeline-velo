import { describe, expect, it } from "vitest";

import { initSliderFills, setSliderFill } from "../src/slider";

function slider(min: string, max: string, value: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "range";
  el.className = "uslider";
  el.min = min;
  el.max = max;
  el.value = value;
  return el;
}

describe("setSliderFill", () => {
  it("sets --fill to the value's fraction of the range", () => {
    const el = slider("0", "100", "25");
    setSliderFill(el);
    expect(el.style.getPropertyValue("--fill")).toBe("0.25");
  });

  it("handles a non-zero minimum", () => {
    const el = slider("20", "80", "50"); // (50-20)/(80-20) = 0.5
    setSliderFill(el);
    expect(el.style.getPropertyValue("--fill")).toBe("0.5");
  });

  it("clamps below 0 and above 1", () => {
    const lo = slider("0", "10", "-5");
    setSliderFill(lo);
    expect(lo.style.getPropertyValue("--fill")).toBe("0");
    const hi = slider("0", "10", "99");
    setSliderFill(hi);
    expect(hi.style.getPropertyValue("--fill")).toBe("1");
  });

  it("is safe when min === max (zero span)", () => {
    const el = slider("5", "5", "5");
    setSliderFill(el);
    expect(el.style.getPropertyValue("--fill")).toBe("0");
  });
});

describe("initSliderFills", () => {
  it("fills every .uslider under the root, ignoring other inputs", () => {
    const root = document.createElement("div");
    const a = slider("0", "10", "5");
    const b = slider("0", "4", "1");
    const plain = document.createElement("input");
    plain.type = "range"; // no .uslider class
    plain.min = "0";
    plain.max = "10";
    plain.value = "5";
    root.append(a, b, plain);

    initSliderFills(root);

    expect(a.style.getPropertyValue("--fill")).toBe("0.5");
    expect(b.style.getPropertyValue("--fill")).toBe("0.25");
    expect(plain.style.getPropertyValue("--fill")).toBe("");
  });
});
