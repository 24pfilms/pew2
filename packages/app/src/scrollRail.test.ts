import { describe, expect, test } from "bun:test";
import { RAIL_MIN_THUMB, railDots, railThumb } from "./scrollRail";

describe("railThumb", () => {
  test("no rail when the content fits", () => {
    expect(railThumb(300, 300, 0).overflows).toBe(false);
    expect(railThumb(300, 120, 0).overflows).toBe(false);
    expect(railThumb(0, 500, 0).overflows).toBe(false);
  });

  test("thumb length is the visible share of the content", () => {
    const t = railThumb(300, 600, 0);
    expect(t.overflows).toBe(true);
    expect(t.length).toBe(150);
    expect(t.offset).toBe(0);
  });

  test("thumb reaches the bottom of the rail at the end of the content", () => {
    const t = railThumb(300, 600, 300);
    expect(t.offset + t.length).toBe(300);
  });

  test("a very long list keeps a thumb you can see", () => {
    expect(railThumb(300, 100_000, 0).length).toBe(RAIL_MIN_THUMB);
  });

  test("overscroll squeezes the thumb against the end instead of leaving the rail", () => {
    const top = railThumb(300, 600, -40);
    expect(top.offset).toBe(0);
    expect(top.length).toBe(110);
    const bottom = railThumb(300, 600, 340);
    expect(bottom.length).toBe(110);
    expect(bottom.offset + bottom.length).toBe(300);
  });
});

describe("railDots", () => {
  test("one dot per pitch, never fewer than two", () => {
    expect(railDots(300, 6)).toBe(50);
    expect(railDots(5, 6)).toBe(2);
    expect(railDots(0, 6)).toBe(0);
  });
});
