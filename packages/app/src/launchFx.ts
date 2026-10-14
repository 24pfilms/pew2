/**
 * The New goal launch: Ken charging up under your thumb, bursting across the
 * whole screen, and the goal's session opening out of the blast.
 *
 * Pure and Expo-free (tested under bun): every frame is a function of the
 * moment, not of state carried between frames, so a dropped frame never puts
 * a particle in the wrong place and a test can paint any instant. Drawing goes
 * through `FxPainter`; `ui/LaunchFx.tsx` paints it with Skia on the UI thread,
 * which is why everything here is a worklet. Helpers sit above their callers:
 * a worklet cannot call a function declared below it.
 *
 * The three phases, all driven from outside:
 *
 *   charge  0..1 while the thumb is down. Dots stream in from the screen edges
 *           and spiral into Ken, his aura swells, and the ring round him lights
 *           dot by dot, trembling near the end.
 *   burst   seconds since the blast (negative: not yet). A flash, two shock
 *           rings racing to the corners, Ken's own dots flung outward, and the
 *           LED grid lighting up behind the shock: the whole screen turns over
 *           to GG Goals purple.
 *   reveal  0..1. A hole opens from where Ken was, rimmed with lit dots, and
 *           the session underneath shows through it until it fills the screen.
 */

export type FxRGB = readonly [number, number, number];

export interface FxPainter {
  /** A solid dot. */
  dot(x: number, y: number, r: number, c: FxRGB, a: number): void;
  /** A soft additive halo. */
  glow(x: number, y: number, r: number, c: FxRGB, a: number): void;
  /** A stroked circle. */
  ring(cx: number, cy: number, r: number, width: number, c: FxRGB, a: number): void;
  /** The whole screen in one colour, with a round hole (radius `hole`, 0 for none) at the scene's centre. */
  cover(c: FxRGB, a: number, hole: number): void;
  /** A disc fading from `c` at the centre to nothing at its edge. */
  radial(cx: number, cy: number, r: number, c: FxRGB, a: number): void;
}

export interface FxScene {
  /** Screen size in points. */
  w: number;
  h: number;
  /** Ken's centre on screen. */
  cx: number;
  cy: number;
  /** Ken's radius. */
  kenR: number;
}

export interface FxPalette {
  /** The screen behind everything. */
  bg: FxRGB;
  /** Ken's lit colour. */
  base: FxRGB;
  /** Ken's brightest colour. */
  light: FxRGB;
  /** An unlit ring dot. */
  off: FxRGB;
}

export interface FxMoment {
  /** Seconds, any running clock. */
  t: number;
  charge: number;
  /** Seconds since the burst; negative before it. */
  burst: number;
  reveal: number;
  /** 1 normally; eases to 0 when a launch is called off, taking the burst with it. */
  fade: number;
}

/** Dots in the ring round Ken: one lights per step of the hold. */
export const RING_DOTS = 24;
/** The ring's radius, as a multiple of Ken's. */
export const RING_SCALE = 2.2;
/** Dots flung out by the burst. */
export const BURST_DOTS = 220;
/** Dots streaming in while charging. */
export const CHARGE_DOTS = 90;
/** The shock wave reaches the far corner in this many seconds. */
export const SHOCK_S = 0.75;
/** Spacing of the LED grid the burst lights. */
export const GRID_PITCH = 22;
/** How long the burst plays before the session may open. */
export const BURST_MIN_S = 0.9;

const WHITE: FxRGB = [255, 255, 255];

/** A stable pseudo-random 0..1 for particle `i`, stream `k`. */
export function fxRand(i: number, k: number): number {
  "worklet";
  const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function fxClamp01(x: number): number {
  "worklet";
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Cubic ease-out. */
export function fxEaseOut(x: number): number {
  "worklet";
  const u = 1 - fxClamp01(x);
  return 1 - u * u * u;
}

export function fxSmooth(a: number, b: number, x: number): number {
  "worklet";
  const u = fxClamp01((x - a) / (b - a));
  return u * u * (3 - 2 * u);
}

/** Distance from Ken to the farthest screen corner: how far the shock must travel. */
export function fxReach(s: FxScene): number {
  "worklet";
  const dx = Math.max(s.cx, s.w - s.cx);
  const dy = Math.max(s.cy, s.h - s.cy);
  return Math.sqrt(dx * dx + dy * dy);
}

/** The shock front's radius `b` seconds after the burst. */
export function fxShock(s: FxScene, b: number): number {
  "worklet";
  return b < 0 ? 0 : fxReach(s) * 1.08 * fxEaseOut(b / SHOCK_S);
}

/** The reveal hole's radius for `r` in 0..1: closed at 0, past every corner at 1. */
export function fxHole(s: FxScene, r: number): number {
  "worklet";
  return r <= 0 ? 0 : (fxReach(s) + 24) * fxEaseOut(r);
}

/**
 * Where burst particle `i` is `b` seconds in, and how bright: it leaves from
 * somewhere inside Ken (they are his dots) and slows under drag.
 */
export function fxBurstDot(s: FxScene, i: number, b: number, out: Float32Array): void {
  "worklet";
  const ang = fxRand(i, 1) * Math.PI * 2;
  const r0 = Math.sqrt(fxRand(i, 2)) * s.kenR * 0.85;
  const ox = s.cx + Math.cos(ang) * r0;
  const oy = s.cy + Math.sin(ang) * r0;
  // Mostly outward from where it sat, a little scattered.
  const dir = ang + (fxRand(i, 3) - 0.5) * 0.5;
  const speed = 420 + fxRand(i, 4) * 1500;
  const drag = 1.8 + fxRand(i, 5) * 1.6;
  const d = (speed / drag) * (1 - Math.exp(-drag * b));
  // A slow swirl, so the cloud turns rather than only spreading.
  const swirl = dir + 0.22 * (1 - Math.exp(-1.5 * b)) * (fxRand(i, 6) < 0.5 ? -1 : 1);
  const life = 1.1 + fxRand(i, 7) * 1.1;
  out[0] = ox + Math.cos(swirl) * d;
  out[1] = oy + Math.sin(swirl) * d;
  out[2] = (1.4 + fxRand(i, 8) * 2.8) * (1 - 0.35 * fxClamp01(b / life));
  out[3] = b < 0 ? 0 : 1 - fxSmooth(life * 0.45, life, b);
}

/**
 * Where incoming particle `i` is while charging: born past the screen edge,
 * spiralling in and vanishing as it reaches Ken. More of them, faster, the
 * fuller the charge.
 */
export function fxChargeDot(s: FxScene, i: number, t: number, charge: number, out: Float32Array): void {
  "worklet";
  const shown = CHARGE_DOTS * Math.pow(fxClamp01(charge), 0.7);
  if (i >= shown) {
    out[3] = 0;
    return;
  }
  const period = (0.7 + fxRand(i, 11) * 0.6) / (1 + charge * 1.2);
  const u = (t / period + fxRand(i, 12)) % 1;
  const far = fxReach(s);
  const r = s.kenR * 1.05 + far * Math.pow(1 - u, 1.7);
  const ang = fxRand(i, 13) * Math.PI * 2 + (1 - u) * 1.1 * (0.4 + charge);
  out[0] = s.cx + Math.cos(ang) * r;
  out[1] = s.cy + Math.sin(ang) * r;
  out[2] = 1 + fxRand(i, 14) * 1.6;
  // Fades in at the edge, out as it is swallowed; the newest arrivals fade in.
  out[3] = fxSmooth(0, 0.25, u) * (1 - fxSmooth(0.85, 1, u)) * (0.3 + 0.7 * charge) * fxClamp01(shown - i);
}

/** Ken's tremble while charging, in points: nothing until halfway, violent at the end. */
export function fxShake(t: number, charge: number): number {
  "worklet";
  const k = fxClamp01((charge - 0.35) / 0.65);
  return k * k * 6 * Math.sin(t * 71) * (0.6 + 0.4 * Math.sin(t * 23));
}

/** Ken's size while charging: he swells, then pulls in just before the blast. */
export function fxKenScale(charge: number): number {
  "worklet";
  const c = fxClamp01(charge);
  return 1 + 0.22 * c - 0.12 * fxSmooth(0.9, 1, c);
}

export function paintCharge(s: FxScene, m: FxMoment, pal: FxPalette, p: FxPainter, SCRATCH: Float32Array): void {
  "worklet";
  const c = fxClamp01(m.charge);
  // The ring is always there on the launch step: the target to hold.
  const ringR = s.kenR * RING_SCALE;
  const lit = c * RING_DOTS;
  const tremble = fxClamp01((c - 0.6) / 0.4);
  for (let i = 0; i < RING_DOTS; i++) {
    const a = (i / RING_DOTS) * Math.PI * 2 - Math.PI / 2;
    const wob = tremble * 4 * Math.sin(m.t * 37 + i * 1.7);
    const x = s.cx + Math.cos(a) * (ringR + wob);
    const y = s.cy + Math.sin(a) * (ringR + wob);
    const on = fxClamp01(lit - i);
    p.dot(x, y, 3.5, pal.off, 1 - on);
    if (on > 0) {
      p.glow(x, y, 14 + 10 * c, pal.base, 0.55 * on);
      p.dot(x, y, 3.5 + 1.2 * c, pal.light, on);
    }
  }
  if (c <= 0) return;
  // The aura swelling behind Ken.
  p.radial(s.cx, s.cy, s.kenR * (1.3 + 1.6 * c), pal.base, 0.12 + 0.5 * c * c);
  for (let i = 0; i < CHARGE_DOTS; i++) {
    fxChargeDot(s, i, m.t, c, SCRATCH);
    const a = SCRATCH[3]!;
    if (a <= 0.01) continue;
    p.dot(SCRATCH[0]!, SCRATCH[1]!, SCRATCH[2]!, fxRand(i, 15) < 0.4 ? pal.light : pal.base, a);
  }
}

export function paintBurst(s: FxScene, m: FxMoment, pal: FxPalette, p: FxPainter, SCRATCH: Float32Array): void {
  "worklet";
  const b = m.burst;
  const fade = fxClamp01(m.fade);
  const hole = fxHole(s, m.reveal);
  // The screen turns over: everything behind is covered from the first frame.
  p.cover(pal.bg, fade, hole);
  // The LED grid, lit as the shock passes and left glowing faintly after,
  // breathing outward while the session is being made.
  const shock = fxShock(s, b);
  const cols = Math.ceil(s.w / GRID_PITCH) + 1;
  const rows = Math.ceil(s.h / GRID_PITCH) + 1;
  const ox = (s.w - (cols - 1) * GRID_PITCH) / 2;
  const oy = (s.h - (rows - 1) * GRID_PITCH) / 2;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = ox + gx * GRID_PITCH;
      const y = oy + gy * GRID_PITCH;
      const dx = x - s.cx;
      const dy = y - s.cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > shock || d < hole) continue;
      const crest = Math.exp(-(shock - d) / 70);
      const rest = 0.2 + 0.1 * Math.sin(m.t * 2.4 - d / 45);
      const a = (rest + 0.85 * crest) * fade;
      if (a <= 0.02) continue;
      p.dot(x, y, 1.3 + 1.4 * crest, crest > 0.4 ? pal.light : pal.base, a);
    }
  }
  // The flash: the whole screen, then the core where Ken was.
  if (b < 0.6) {
    p.cover(pal.light, 0.75 * Math.exp(-b * 9) * fade, hole);
    p.radial(s.cx, s.cy, s.kenR * (1.5 + b * 14), WHITE, Math.exp(-b * 5) * fade);
  }
  // Two shock rings racing to the corners.
  for (let k = 0; k < 2; k++) {
    const bk = b - k * 0.12;
    if (bk <= 0 || bk > SHOCK_S) continue;
    const q = bk / SHOCK_S;
    p.ring(s.cx, s.cy, fxShock(s, bk), (k === 0 ? 16 : 7) * (1 - q) + 1.5, k === 0 ? pal.light : WHITE, Math.pow(1 - q, 1.4) * 0.9 * fade);
  }
  // The rim of the opening, lit while it widens.
  if (m.reveal > 0 && m.reveal < 1) {
    const rimA = (1 - fxSmooth(0.55, 1, m.reveal)) * fade;
    const n = 56;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + m.t * 0.6;
      const x = s.cx + Math.cos(a) * hole;
      const y = s.cy + Math.sin(a) * hole;
      p.glow(x, y, 16, pal.base, 0.5 * rimA);
      p.dot(x, y, 2.6, pal.light, rimA);
    }
  }
  // Ken's own dots, flung out over everything (even across the opening).
  for (let i = 0; i < BURST_DOTS; i++) {
    fxBurstDot(s, i, b, SCRATCH);
    const a = SCRATCH[3]! * fade;
    if (a <= 0.01) continue;
    const x = SCRATCH[0]!;
    const y = SCRATCH[1]!;
    if (x < -20 || y < -20 || x > s.w + 20 || y > s.h + 20) continue;
    const big = i % 5 === 0;
    const col = fxRand(i, 9) < 0.2 ? WHITE : fxRand(i, 9) < 0.6 ? pal.light : pal.base;
    if (big) p.glow(x, y, SCRATCH[2]! * 5, pal.base, 0.45 * a);
    p.dot(x, y, SCRATCH[2]!, col, a);
  }
}

/** One frame of the launch at moment `m`. */
export function paintLaunch(s: FxScene, m: FxMoment, pal: FxPalette, p: FxPainter): void {
  "worklet";
  // Per frame, not a module constant: a worklet gets its own frozen copy of
  // anything it captures.
  const scratch = new Float32Array(4);
  if (m.burst >= 0) paintBurst(s, m, pal, p, scratch);
  else paintCharge(s, m, pal, p, scratch);
}
