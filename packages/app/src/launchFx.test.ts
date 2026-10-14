import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BURST_DOTS,
  fxBurstDot,
  fxChargeDot,
  fxHole,
  fxKenScale,
  fxReach,
  fxShake,
  fxShock,
  paintLaunch,
  RING_DOTS,
  SHOCK_S,
  type FxPainter,
  type FxPalette,
  type FxScene,
} from "./launchFx";

const SCENE: FxScene = { w: 393, h: 852, cx: 196, cy: 470, kenR: 84 };
const PAL: FxPalette = { bg: [10, 10, 12], base: [139, 124, 246], light: [200, 190, 255], off: [52, 54, 62] };

function recorder() {
  const calls = { dot: 0, glow: 0, ring: 0, cover: [] as { a: number; hole: number }[], radial: 0, bad: 0 };
  const check = (...n: number[]) => {
    if (n.some((v) => !Number.isFinite(v))) calls.bad++;
  };
  const p: FxPainter = {
    dot: (x, y, r, _c, a) => (check(x, y, r, a), calls.dot++),
    glow: (x, y, r, _c, a) => (check(x, y, r, a), calls.glow++),
    ring: (x, y, r, w, _c, a) => (check(x, y, r, w, a), calls.ring++),
    cover: (_c, a, hole) => (check(a, hole), calls.cover.push({ a, hole })),
    radial: (x, y, r, _c, a) => (check(x, y, r, a), calls.radial++),
  };
  return { p, calls };
}

describe("charging", () => {
  test("at rest only the ring is drawn, unlit, and nothing covers the screen", () => {
    const { p, calls } = recorder();
    paintLaunch(SCENE, { t: 1, charge: 0, burst: -1, reveal: 0, fade: 1 }, PAL, p);
    expect(calls.dot).toBe(RING_DOTS);
    expect(calls.cover).toHaveLength(0);
  });

  test("more dots stream in the fuller the charge", () => {
    const count = (charge: number) => {
      const out = new Float32Array(4);
      let n = 0;
      for (let i = 0; i < 90; i++) {
        fxChargeDot(SCENE, i, 0.37, charge, out);
        if (out[3]! > 0.01) n++;
      }
      return n;
    };
    expect(count(0)).toBe(0);
    expect(count(0.3)).toBeLessThan(count(1));
  });

  test("Ken only trembles past the halfway point, and swells then pulls in", () => {
    expect(Math.abs(fxShake(1.23, 0.2))).toBe(0);
    let most = 0;
    for (let t = 0; t < 1; t += 0.01) most = Math.max(most, Math.abs(fxShake(t, 1)));
    expect(most).toBeGreaterThan(3);
    expect(fxKenScale(0)).toBe(1);
    expect(fxKenScale(0.85)).toBeGreaterThan(fxKenScale(1));
  });
});

describe("the burst", () => {
  test("the shock reaches past the farthest corner", () => {
    expect(fxShock(SCENE, -1)).toBe(0);
    expect(fxShock(SCENE, SHOCK_S)).toBeGreaterThan(fxReach(SCENE));
  });

  test("the screen is covered from the first frame, with a flash", () => {
    const { p, calls } = recorder();
    paintLaunch(SCENE, { t: 2, charge: 1, burst: 0, reveal: 0, fade: 1 }, PAL, p);
    expect(calls.cover[0]).toEqual({ a: 1, hole: 0 });
    expect(calls.cover[1]!.a).toBeGreaterThan(0.5);
  });

  test("Ken's dots leave from inside him, fly outward, and fade out", () => {
    const out = new Float32Array(4);
    let inside = 0;
    let travelled = 0;
    for (let i = 0; i < BURST_DOTS; i++) {
      fxBurstDot(SCENE, i, 0, out);
      if (Math.hypot(out[0]! - SCENE.cx, out[1]! - SCENE.cy) <= SCENE.kenR) inside++;
      fxBurstDot(SCENE, i, 0.6, out);
      travelled += Math.hypot(out[0]! - SCENE.cx, out[1]! - SCENE.cy);
      fxBurstDot(SCENE, i, 3, out);
      expect(out[3]).toBe(0);
    }
    expect(inside).toBe(BURST_DOTS);
    expect(travelled / BURST_DOTS).toBeGreaterThan(150);
  });

  test("the opening grows from nothing to past every corner", () => {
    expect(fxHole(SCENE, 0)).toBe(0);
    expect(fxHole(SCENE, 1)).toBeGreaterThan(fxReach(SCENE));
    const { p, calls } = recorder();
    paintLaunch(SCENE, { t: 3, charge: 1, burst: 1.4, reveal: 0.5, fade: 1 }, PAL, p);
    expect(calls.cover[0]!.hole).toBeGreaterThan(0);
  });

  test("calling it off fades the cover away", () => {
    const { p, calls } = recorder();
    paintLaunch(SCENE, { t: 3, charge: 1, burst: 1.4, reveal: 0, fade: 0 }, PAL, p);
    expect(calls.cover[0]!.a).toBe(0);
  });

  test("every frame of the whole sequence is finite", () => {
    const { p, calls } = recorder();
    for (let f = 0; f < 240; f++) {
      const t = f / 60;
      paintLaunch(SCENE, { t, charge: Math.min(1, t), burst: t - 1.5, reveal: Math.max(0, (t - 2.6) / 0.8), fade: 1 }, PAL, p);
    }
    expect(calls.bad).toBe(0);
  });
});

test("worklets never call a helper declared below them", () => {
  // A worklet captures only what exists where it is defined: a call to a
  // function further down the file is `undefined` on the UI thread.
  const src = readFileSync(join(import.meta.dir, "launchFx.ts"), "utf8");
  const order = [...src.matchAll(/export function (\w+)/g)].map((m) => [m[1]!, m.index!] as const);
  for (const [name, at] of order) {
    for (const [other, otherAt] of order) {
      if (otherAt <= at) continue;
      const body = src.slice(at, order.find(([, i]) => i > at)?.[1] ?? src.length);
      expect(body.includes(`${other}(`)).toBe(false);
    }
    void name;
  }
});
