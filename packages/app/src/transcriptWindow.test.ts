import { describe, expect, test } from "bun:test";
import { loadEarlier, nextWindow, TRANSCRIPT_PAGE, windowTurns } from "./transcriptWindow";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("transcript window", () => {
  test("a short conversation shows everything", () => {
    const w = nextWindow(undefined, "a", 10);
    expect(windowTurns(range(10), w)).toEqual({ visible: range(10), earlier: 0 });
  });

  test("a long one shows the last page", () => {
    const w = nextWindow(undefined, "a", 170);
    const { visible, earlier } = windowTurns(range(170), w);
    expect(visible.length).toBe(TRANSCRIPT_PAGE);
    expect(visible[0]).toBe(120);
    expect(earlier).toBe(120);
  });

  test("appends grow the window without shifting it, then drop a page at once", () => {
    let w = nextWindow(undefined, "a", 100);
    expect(w.start).toBe(50);
    w = nextWindow(w, "a", 101);
    expect(w.start).toBe(50);
    w = nextWindow(w, "a", 150);
    expect(w.start).toBe(50);
    w = nextWindow(w, "a", 151);
    expect(w.start).toBe(101);
    expect(151 - w.start).toBeGreaterThanOrEqual(TRANSCRIPT_PAGE);
  });

  test("load earlier reveals a page and stops at the top", () => {
    let w = nextWindow(undefined, "a", 120);
    w = loadEarlier(w);
    expect(w).toEqual({ session: "a", start: 20, pages: 2 });
    w = loadEarlier(w);
    expect(w.start).toBe(0);
    expect(loadEarlier(w)).toBe(w);
    expect(nextWindow(w, "a", 120)).toBe(w);
  });

  test("another conversation resets to one page", () => {
    const w = loadEarlier(nextWindow(undefined, "a", 200));
    expect(nextWindow(w, "b", 200)).toEqual({ session: "b", start: 150, pages: 1 });
  });

  test("shrinking turns resets", () => {
    const w = nextWindow(undefined, "a", 200);
    expect(nextWindow(w, "a", 20).start).toBe(0);
  });
});
