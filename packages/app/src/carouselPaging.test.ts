import { expect, test } from "bun:test";
import { pageForScroll, type PagingHold } from "./carouselPaging";

const W = 400;

test("an arrow slide never reports the page it is leaving", () => {
  // Arrow from page 0 to 1: the app sets page 1 at once, then the slide's
  // positions arrive. Following them reported 0 again (the flicker).
  const hold: PagingHold = { target: 1 };
  const seen = [12, 90, 180, 260, 340, 399.6].map((x) => pageForScroll(x, W, 7, hold));
  expect(seen.filter((p) => p !== undefined)).toEqual([]);
  // Landed: the hold is released.
  expect(hold.target).toBeUndefined();
});

test("after landing, swiping is followed live again", () => {
  const hold: PagingHold = { target: 1 };
  pageForScroll(400, W, 7, hold);
  expect(pageForScroll(620, W, 7, hold)).toBe(2);
});

test("with no arrow slide, the nearest page is reported and clamped", () => {
  const hold: PagingHold = {};
  expect(pageForScroll(0, W, 7, hold)).toBe(0);
  expect(pageForScroll(590, W, 7, hold)).toBe(1);
  expect(pageForScroll(610, W, 7, hold)).toBe(2);
  expect(pageForScroll(99999, W, 7, hold)).toBe(6);
  expect(pageForScroll(-50, W, 7, hold)).toBe(0);
});
