import { describe, expect, test } from "bun:test";
import { bezierAt, createEntranceLifetime, DUR, dissolvePlan, EASE, lerpFrom, withAlpha, wordDissolve, wordFadeAlpha } from "./motion";

describe("motion tokens", () => {
  test("mirror GG Coder App.css", () => {
    expect(DUR.dissolve).toBe(340);
    expect(DUR.row).toBe(220);
    expect(EASE.out).toEqual([0.22, 1, 0.36, 1]);
    expect(EASE.in).toEqual([0.4, 0, 1, 1]);
  });
});

describe("dissolvePlan", () => {
  test("reduced motion is a short plain fade", () => {
    for (const kind of ["in", "swap", "restore", "row"] as const) {
      const plan = dissolvePlan(kind, true, 200);
      expect(plan).toMatchObject({ duration: DUR.reduced, delay: 0, fromScale: 1, fromOpacity: 0 });
    }
  });
  test("rows never scale (no geometry change after layout)", () => {
    expect(dissolvePlan("row", false).fromScale).toBe(1);
  });
  test("entrances resolve with the dissolve duration and a hair of scale", () => {
    const plan = dissolvePlan("in", false, 40);
    expect(plan.duration).toBe(340);
    expect(plan.delay).toBe(40);
    expect(plan.fromScale).toBeGreaterThan(1);
  });
});

describe("createEntranceLifetime", () => {
  test("each ordinal animates once, only above the high-water mark", () => {
    const life = createEntranceLifetime(5);
    expect(life.consume(3)).toBe(false);
    expect(life.consume(5)).toBe(true);
    expect(life.consume(5)).toBe(false);
    expect(life.consume(7)).toBe(true);
    expect(life.consume(6)).toBe(false);
  });
  test("settle raises the mark without animating", () => {
    const life = createEntranceLifetime(0);
    life.settle(9);
    expect(life.consume(9)).toBe(false);
    expect(life.consume(10)).toBe(true);
  });
});

test("lerpFrom clamps", () => {
  expect(lerpFrom(0, -1)).toBe(0);
  expect(lerpFrom(0.5, 0.5)).toBe(0.75);
  expect(lerpFrom(0, 2)).toBe(1);
});

test("bezierAt matches CSS cubic-bezier endpoints and shape", () => {
  expect(bezierAt(EASE.out, 0)).toBe(0);
  expect(bezierAt(EASE.out, 1)).toBe(1);
  // GG's ease-out lands fast: well past halfway at a quarter of the time.
  expect(bezierAt(EASE.out, 0.25)).toBeGreaterThan(0.6);
  // Linear control points are the identity.
  expect(bezierAt([0, 0, 1, 1], 0.37)).toBeCloseTo(0.37, 4);
  // Monotonic.
  let last = 0;
  for (let i = 1; i <= 20; i++) {
    const v = bezierAt(EASE.out, i / 20);
    expect(v).toBeGreaterThanOrEqual(last);
    last = v;
  }
});

test("wordFadeAlpha is GG's md-word-fade: transparent, then 220ms ease-out to opaque", () => {
  expect(DUR.row).toBe(220);
  expect(wordFadeAlpha(-5)).toBe(0);
  expect(wordFadeAlpha(0)).toBe(0);
  expect(wordFadeAlpha(110)).toBeGreaterThan(0.5);
  expect(wordFadeAlpha(110)).toBeLessThan(1);
  expect(wordFadeAlpha(220)).toBe(1);
  expect(wordFadeAlpha(10_000)).toBe(1);
});

test("withAlpha keeps the colour and scales its opacity", () => {
  expect(withAlpha("#f2f2f5", 0.5)).toBe("rgba(242,242,245,0.5)");
  expect(withAlpha("#fff", 1)).toBe("rgba(255,255,255,1)");
  expect(withAlpha("#ffffff80", 0.5)).toBe("rgba(255,255,255,0.251)");
  expect(withAlpha("rgba(10,20,30,0.5)", 0.5)).toBe("rgba(10,20,30,0.25)");
  expect(withAlpha("rgb(1,2,3)", 2)).toBe("rgba(1,2,3,1)");
  expect(withAlpha("red", 0.5)).toBe("red");
});

test("a streamed word resolves out of a blur into sharp text", () => {
  const start = wordDissolve(0);
  expect(start.alpha).toBe(0);
  expect(start.blur).toBeGreaterThan(5);
  expect(start.glow).toBeGreaterThan(0.5);
  const mid = wordDissolve(DUR.word / 3);
  expect(mid.alpha).toBeGreaterThan(0.5);
  expect(mid.blur).toBeLessThan(start.blur);
  expect(wordDissolve(DUR.word)).toEqual({ alpha: 1, blur: 0, glow: 0 });
  // Long enough to be seen on a phone, unlike the desktop's 220ms row fade.
  expect(DUR.word).toBeGreaterThanOrEqual(400);
  // Monotonic: never re-blurs.
  let prev = wordDissolve(0);
  for (let ms = 20; ms <= DUR.word; ms += 20) {
    const next = wordDissolve(ms);
    expect(next.alpha).toBeGreaterThanOrEqual(prev.alpha);
    expect(next.blur).toBeLessThanOrEqual(prev.blur);
    prev = next;
  }
});
