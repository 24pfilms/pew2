/**
 * Pew, pew2's mascot: the engine.
 *
 * A ball of LED dots (the pew2 icon's dots wrapped round a sphere) whose face
 * is made of lit dots. Every dot rides its own spring towards a target that
 * depends on the mood, so the body wobbles, ripples and settles on its own;
 * the face, the light patterns and the little extras around the head are all
 * computed per frame. Ported from the "Pew Matrix" prototype the user chose
 * (`~/.gg/goals/pew2-gg/mascot/pew.html`).
 *
 * Pure and Expo-free: no React, no Skia. Drawing goes through a tiny
 * `PewPainter` interface (dots, glows, ovals, lines, polygons, a shadow), so
 * `bun test` can record a frame and the app can paint the same frame with
 * Skia. Every function carries the `"worklet"` directive because the app runs
 * this on the UI thread (`Pew.tsx`); to `bun` the directive is an inert
 * string.
 *
 * Coordinates are in points inside an S×S box. Time `t` is in seconds.
 */

export type PewMood = "idle" | "thinking" | "working" | "talking" | "happy" | "sleepy" | "oops";

export const PEW_MOODS: readonly PewMood[] = ["idle", "thinking", "working", "talking", "happy", "sleepy", "oops"];

/** 0..255 per channel. */
export type RGB = [number, number, number];

export interface PewPalette {
  /** The brightest lit LED. */
  light: RGB;
  /** A lit LED. */
  base: RGB;
  dark: RGB;
  /** Glow around lit dots and the face. */
  glow: RGB;
  /** The face at small sizes. */
  eye: RGB;
  /** An unlit LED: the body's resting colour. */
  off: RGB;
}

export interface PewPainter {
  dot(x: number, y: number, r: number, c: RGB, a: number): void;
  /** A soft additive halo of radius `r`. */
  glow(x: number, y: number, r: number, c: RGB, a: number): void;
  /** A filled ellipse, rotated by `rot` radians, with an optional halo `glowR` in `gc`. */
  oval(cx: number, cy: number, rx: number, ry: number, rot: number, c: RGB, a: number, glowR: number, gc: RGB): void;
  /** A round-capped polyline `[x0, y0, x1, y1, …]`, with an optional halo. */
  line(pts: number[], width: number, c: RGB, a: number, glowR: number, gc: RGB): void;
  /** A filled polygon `[x0, y0, …]`. */
  poly(pts: number[], c: RGB, a: number): void;
  /** The soft ground shadow: an ellipse fading out from its centre. */
  shadow(cx: number, cy: number, w: number, h: number, a: number): void;
}

/** Everything one Pew remembers between frames. Lives on the UI thread. */
export interface PewBody {
  S: number;
  n: number;
  home: Float32Array;
  p: Float32Array;
  v: Float32Array;
  rnd: Float32Array;
  lat: Float32Array;
  lon: Float32Array;
  /** Per point after projection: sx, sy, z, f (perspective), lambert, nx, ny. */
  scr: Float32Array;
  order: number[];
  yaw: number;
  pitch: number;
  spinV: number;
  yawExtra: number;
  pitchExtra: number;
  pitchV: number;
  dragging: boolean;
  /** Until when a poke keeps it happy (seconds, same clock as `t`). */
  reactUntil: number;
  mood: PewMood | "";
  since: number;
  /**
   * The mood it was showing before the current one, and the face blends out
   * of it over FACE_BLEND seconds: a poke's smile eases back to the resting
   * face, a working face eases into a happy one, rather than snapping.
   */
  prevMood: PewMood | "";
  /** Last time it was advanced; also "now" for gestures. */
  last: number;
  lookX: number;
  lookY: number;
  /** Sleeping style 0..9 (`PEW_SLEEP_STYLES`): how it dozes in the sleepy mood. */
  sleep: number;
  /** The seed it was built from (-1 for none), so a host can tell when to rebuild. */
  seed: number;
  /** Breathing phase (radians) and rate so two dozing Pews never move in sync. */
  sleepPh: number;
  sleepRate: number;
}

/** How many sleeping styles there are. */
export const PEW_SLEEP_STYLES = 10;

/** A stable 32-bit hash of a string (FNV-1a): seeds a Pew's sleeping style. */
export function pewSleepSeed(key: string): number {
  "worklet";
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Final avalanche so ids differing only in their last char spread out.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** The sleeping style (0..9) for a key such as a provider id. */
export function pewSleepStyle(key: string): number {
  "worklet";
  return pewSleepSeed(key) % PEW_SLEEP_STYLES;
}

// ── constants ───────────────────────────────────────────────

const TAU = Math.PI * 2;
/** Perspective distance, in body radii. */
const D = 4.5;
/** Body radius as a share of the box. */
const SCALE = 0.29;
const SPRING_K = 90;
const SPRING_C = 11;
const SEED = 1.6;
/** Upper-left key light. */
const LIGHT: RGB = [-0.4703, 0.6271, 0.6898];
export const PEW_AMBER: RGB = [242, 180, 90];
const AMBER_INK: RGB = [35, 23, 3];
const WHITE: RGB = [255, 255, 255];
/** Below this many dots the face is drawn as shapes (an LED face would be a smudge). */
const LED_FACE_MIN = 300;
/** Extras (thought bubbles, z's, sparkles) need room to read. */
const EXTRAS_MIN = 56;
/** How far a small Pew's unlit dots glow toward its colour (0 off, 1 lit). */
const SMALL_GLOW = 0.6;
const SMALL_GLOW_SLEEPY = 0.42;

// ── small maths ─────────────────────────────────────────────

export function clamp(v: number, a: number, b: number): number {
  "worklet";
  return v < a ? a : v > b ? b : v;
}
function lerp(a: number, b: number, t: number): number {
  "worklet";
  return a + (b - a) * t;
}
function smooth(e0: number, e1: number, x: number): number {
  "worklet";
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function fract(x: number): number {
  "worklet";
  return x - Math.floor(x);
}
export function hash(n: number): number {
  "worklet";
  return fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);
}
// ORDER MATTERS. On the UI thread each worklet captures the helpers it calls
// at the moment it is defined, so a helper declared further down is captured
// as undefined: "fract is not a function", "talkOpen is not a function".
// bun tests run on the JS thread, where order doesn't matter, so the test
// "no worklet calls a helper declared below it" guards this instead.

/** Sleep time: the clock run at this Pew's own breathing rate and phase. */
function sleepClock(B: PewBody, t: number): number {
  "worklet";
  return t * B.sleepRate + B.sleepPh;
}

/** Nodding off (style 5): 0 upright .. 1 head dropped; a slow dip then a jerk back up. */
function nodDip(T: number): number {
  "worklet";
  const p = fract(T / 4.6);
  return p < 0.82 ? smooth(0.1, 0.82, p) : 1 - smooth(0.82, 0.88, p);
}

/** How open the mouth is while talking, 0..1: syllables, not a metronome. */
export function talkOpen(t: number): number {
  "worklet";
  const syllable = 0.5 + 0.5 * Math.sin(t * 13.5);
  const phrase = 0.55 + 0.45 * Math.sin(t * 2.3 + Math.sin(t * 0.7) * 2);
  const pause = fract(t / 3.1) > 0.82 ? 0.15 : 1;
  return clamp(syllable * phrase * pause, 0, 1);
}

function wrapAngle(a: number): number {
  "worklet";
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}
function mixInto(out: RGB, a: RGB, b: RGB, t: number): RGB {
  "worklet";
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// ── the body ────────────────────────────────────────────────

/** How many dots a Pew of edge `S` is made of. */
export function pewCount(S: number): number {
  "worklet";
  return S > 140 ? 1000 : S > 50 ? 420 : S > 28 ? 180 : 120;
}

/**
 * Rows of dots, like an LED globe: the pew2 icon wrapped round a ball.
 * Alternate rows are offset half a dot so the grid reads as a weave.
 */
export function gridPoints(target: number): Float32Array {
  "worklet";
  const rows = Math.max(7, Math.round(Math.sqrt(target / 1.27)));
  const pts: number[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = -Math.PI / 2 + ((r + 0.5) / rows) * Math.PI;
    const cols = Math.max(4, Math.round(rows * 2 * Math.cos(lat)));
    for (let c = 0; c < cols; c++) {
      const lon = (c / cols) * TAU + (r % 2) * (Math.PI / cols);
      pts.push(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    }
  }
  return Float32Array.from(pts);
}

/**
 * A new Pew. It starts as a speck at its centre and bursts out to its full
 * size on the first frames, which is its "coming alive" entrance.
 */
export function makePewBody(S: number, seed?: number): PewBody {
  "worklet";
  const sd = Math.abs(Math.floor(seed ?? 0));
  const sleep = sd % PEW_SLEEP_STYLES;
  // Style 0 with no seed keeps the original timing exactly.
  const ph = seed === undefined ? 0 : hash(Math.floor(sd / PEW_SLEEP_STYLES) * 0.013 + sleep * 3.7);
  const home = gridPoints(pewCount(S));
  const n = home.length / 3;
  const rnd = new Float32Array(n);
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const p = new Float32Array(n * 3);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    rnd[i] = hash(i * 1.37 + 0.5);
    lat[i] = Math.asin(clamp(home[i * 3 + 1]!, -1, 1));
    lon[i] = Math.atan2(home[i * 3 + 2]!, home[i * 3]!);
    order.push(i);
  }
  for (let i = 0; i < n * 3; i++) p[i] = home[i]! * 0.05;
  return {
    S,
    n,
    home,
    p,
    v: new Float32Array(n * 3),
    rnd,
    lat,
    lon,
    scr: new Float32Array(n * 7),
    order,
    yaw: 0,
    pitch: 0,
    spinV: 0,
    yawExtra: 0,
    pitchExtra: 0,
    pitchV: 0,
    dragging: false,
    reactUntil: -1,
    mood: "",
    since: 0,
    prevMood: "",
    last: 0,
    lookX: 0,
    lookY: 0,
    sleep,
    seed: seed === undefined ? -1 : sd,
    sleepPh: ph * TAU,
    sleepRate: seed === undefined ? 1 : 0.82 + 0.36 * hash(ph * 91.7 + 2.1),
  };
}

interface MoodState {
  mood: PewMood;
  age: number;
  decay: number;
}

/** The mood it is actually showing: a poke makes it happy for a moment. */
function effectiveMood(B: PewBody, t: number, mood: PewMood): MoodState {
  "worklet";
  const shown: PewMood = t < B.reactUntil ? "happy" : mood;
  if (shown !== B.mood) {
    B.prevMood = B.mood;
    B.mood = shown;
    B.since = t;
  }
  const age = Math.max(0, t - B.since);
  return { mood: shown, age, decay: Math.max(0, 1 - age / 0.8) };
}

/** Where point `i` wants to be, for this mood. */
function target(o: Float32Array, i: number, B: PewBody, t: number, st: MoodState): void {
  "worklet";
  const h = B.home;
  const x = h[i * 3]!;
  const y = h[i * 3 + 1]!;
  const z = h[i * 3 + 2]!;
  const lat = B.lat[i]!;
  const r = B.rnd[i]!;
  let k = 1 + 0.015 * Math.sin(t * 2 + y * 3);
  let sx = 1;
  let sy = 1;
  switch (st.mood) {
    case "thinking":
      k = 1 + 0.045 * Math.sin(lat * 7 - t * 3);
      break;
    case "working":
      k = 1 + 0.07 * Math.sin(lat * 7 - t * 7);
      break;
    case "talking":
      k = 1 + 0.015 * Math.sin(t * 2 + y * 3) + 0.012 * talkOpen(t) * (y < 0 ? 1 : 0.3);
      break;
    case "happy":
      k = 1 + 0.04 * Math.sin(t * 8) + 0.03 * Math.sin(lat * 5 + t * 10);
      break;
    case "sleepy":
      k = 1 + 0.02 * Math.sin(sleepClock(B, t) * (B.sleep === 6 ? 0.6 : 1.1));
      sy = B.sleep === 6 ? 0.8 : 0.88;
      sx = B.sleep === 6 ? 1.1 : 1.06;
      break;
    case "oops":
      k = 1 + 0.2 * st.decay * st.decay * (r - 0.3) + 0.012 * Math.sin(t * 40 + r * 30);
      break;
    default:
      break;
  }
  o[0] = x * k * sx;
  o[1] = y * k * sy;
  o[2] = z * k * sx;
}

const TMP = new Float32Array(3);

function step(B: PewBody, t: number, dt: number, st: MoodState): void {
  "worklet";
  const p = B.p;
  const v = B.v;
  const o = TMP;
  for (let i = 0; i < B.n; i++) {
    target(o, i, B, t, st);
    const kk = SPRING_K * (0.75 + 0.5 * B.rnd[i]!);
    for (let a = 0; a < 3; a++) {
      const j = i * 3 + a;
      v[j] = v[j]! + ((o[a]! - p[j]!) * kk - v[j]! * SPRING_C) * dt;
      p[j] = p[j]! + v[j]! * dt;
    }
  }
}

/**
 * Idle life: every so often it glances to one side, and now and then it hops.
 * Deterministic in `t` so it needs no state.
 */
function idleGlance(t: number): number {
  "worklet";
  const period = 9.7;
  const ph = fract(t / period);
  if (ph > 0.14) return 0;
  const side = hash(Math.floor(t / period)) > 0.5 ? 1 : -1;
  return side * 0.75 * Math.sin((ph / 0.14) * Math.PI);
}
function idleHop(t: number): number {
  "worklet";
  const ph = fract(t / 13.3 + 0.4);
  return ph < 0.09 ? Math.sin((ph / 0.09) * Math.PI) : 0;
}

function turn(B: PewBody, t: number, dt: number, st: MoodState): void {
  "worklet";
  let yawT = 0;
  let pitchT: number;
  let spin = 0;
  switch (st.mood) {
    case "thinking":
      yawT = Math.sin(t * 0.9) * 0.85;
      pitchT = 0.25 + Math.sin(t * 1.3) * 0.08;
      break;
    case "working":
      spin = 2.3;
      pitchT = Math.sin(t * 1.7) * 0.12;
      break;
    case "sleepy": {
      const sl = B.sleep;
      yawT = sl === 3 ? -0.3 : sl === 4 ? 0.4 : sl === 1 ? 0.04 : 0.12;
      pitchT = sl === 5 ? -0.2 - 0.45 * nodDip(sleepClock(B, t)) : sl === 6 ? -0.42 : -0.3;
      break;
    }
    default:
      yawT = B.lookX * 0.6 + Math.sin(t * 0.7) * 0.15 + (st.mood === "idle" ? idleGlance(t) : 0);
      pitchT = B.lookY * 0.38 + Math.sin(t * 0.9) * 0.05;
  }
  if (st.mood === "happy") yawT += Math.sin(t * 10) * 0.1;
  if (spin) B.yaw += spin * dt;
  else B.yaw += wrapAngle(yawT - B.yaw) * (1 - Math.exp(-dt * 5));
  B.pitch += (pitchT - B.pitch) * (1 - Math.exp(-dt * 5));
  if (!B.dragging) {
    B.yawExtra += B.spinV * dt;
    B.spinV *= Math.exp(-dt * 1.4);
    if (Math.abs(B.spinV) < 0.6) {
      const home = Math.round(B.yawExtra / TAU) * TAU;
      B.yawExtra += (home - B.yawExtra) * (1 - Math.exp(-dt * 3));
    }
    B.pitchV += (-B.pitchExtra * 40 - B.pitchV * 9) * dt;
    B.pitchExtra += B.pitchV * dt;
  }
}

/**
 * One frame of life. `look` is where something interesting is, -1..1 on each
 * axis (a finger, the composer); without one it drifts and glances by itself.
 */
export function advancePew(B: PewBody, t: number, dt: number, mood: PewMood, lookX?: number, lookY?: number): void {
  "worklet";
  const step_ = clamp(dt, 0.001, 1 / 30);
  B.last = t;
  const st = effectiveMood(B, t, mood);
  const tx = lookX ?? Math.sin(t * 0.5) * 0.3;
  const ty = lookY ?? Math.sin(t * 0.37) * 0.2;
  const ease = 1 - Math.exp(-step_ * 5);
  B.lookX += (clamp(tx, -1, 1) - B.lookX) * ease;
  B.lookY += (clamp(ty, -1, 1) - B.lookY) * ease;
  turn(B, t, step_, st);
  step(B, t, step_, st);
}

/** Jump straight to the resting pose for `mood` (reduced motion, paused). */
export function settlePew(B: PewBody, t: number, mood: PewMood, lookX = 0, lookY = 0): void {
  "worklet";
  B.last = t;
  const st = effectiveMood(B, t, mood);
  B.lookX = lookX;
  B.lookY = lookY;
  const o = TMP;
  for (let i = 0; i < B.n; i++) {
    target(o, i, B, t, st);
    for (let a = 0; a < 3; a++) {
      B.p[i * 3 + a] = o[a]!;
      B.v[i * 3 + a] = 0;
    }
  }
  B.yaw = mood === "sleepy" ? (B.sleep === 3 ? -0.3 : B.sleep === 4 ? 0.4 : B.sleep === 1 ? 0.04 : 0.12) : lookX * 0.6;
  B.pitch = mood === "sleepy" ? (B.sleep === 5 ? -0.45 : B.sleep === 6 ? -0.42 : -0.3) : mood === "thinking" ? 0.25 : lookY * 0.38;
}

// ── touch ───────────────────────────────────────────────────

/** A tap at (x, y) in the box: a ripple out from the finger, and a happy moment. */
export function pokePew(B: PewBody, x: number, y: number): void {
  "worklet";
  const R = B.S * SCALE;
  const reach = R * 0.6;
  const s = B.scr;
  const p = B.p;
  const v = B.v;
  for (let i = 0; i < B.n; i++) {
    const d = Math.hypot(s[i * 7]! - x, s[i * 7 + 1]! - y);
    if (d > reach || s[i * 7 + 2]! < -0.3) continue;
    const fall = 1 - d / reach;
    const len = Math.hypot(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!) || 1;
    const push = 3.4 * fall * fall;
    v[i * 3] = v[i * 3]! - (p[i * 3]! / len) * push;
    v[i * 3 + 1] = v[i * 3 + 1]! - (p[i * 3 + 1]! / len) * push;
    v[i * 3 + 2] = v[i * 3 + 2]! - (p[i * 3 + 2]! / len) * push;
  }
  B.reactUntil = B.last + 1.3;
}

/** A drag of (dx, dy) points taking `dt` seconds: spins it, with momentum. */
export function dragPew(B: PewBody, dx: number, dy: number, dt: number): void {
  "worklet";
  B.dragging = true;
  B.yawExtra += dx * 0.013;
  B.pitchExtra = clamp(B.pitchExtra + dy * 0.009, -0.9, 0.9);
  B.spinV = lerp(B.spinV, (dx * 0.013) / Math.max(0.008, dt), 0.5);
}

/** The finger lifted: it keeps spinning and springs back upright. */
export function releasePew(B: PewBody): void {
  "worklet";
  B.dragging = false;
}

// ── motion, light and projection ────────────────────────────

interface Motion {
  hop: number;
  sx: number;
  sy: number;
  rot: number;
  dx: number;
}

function motion(mood: PewMood, t: number, age: number, S: number, B: PewBody): Motion {
  "worklet";
  let hop = 0;
  let sx = 1;
  let sy = 1;
  let rot = 0;
  let dx = 0;
  switch (mood) {
    case "idle": {
      const b = Math.sin(t * 2.1) * 0.02;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = Math.sin(t * 1.1) * 0.025;
      const h = idleHop(t);
      hop = h * S * 0.045;
      if (h > 0) {
        const squash = Math.pow(1 - h, 4) * 0.08;
        sy -= squash;
        sx += squash * 0.8;
      }
      break;
    }
    case "talking": {
      const b = Math.sin(t * 2.1) * 0.015 + talkOpen(t) * 0.012;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = Math.sin(t * 1.4) * 0.03;
      break;
    }
    case "thinking": {
      rot = -0.08 + Math.sin(t * 1.4) * 0.035;
      const b = Math.sin(t * 1.6) * 0.018;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      break;
    }
    case "working": {
      const h = Math.abs(Math.sin(t * 6.4));
      hop = h * S * 0.05;
      const k = Math.pow(1 - h, 6) * 0.13;
      sy = 1 - k + 0.03 * h;
      sx = 1 + k * 0.8 - 0.015 * h;
      rot = Math.sin(t * 3.2) * 0.03;
      break;
    }
    case "happy": {
      const h = Math.abs(Math.sin(t * 5));
      hop = h * S * 0.05;
      const k = Math.pow(1 - h, 6) * 0.12;
      sy = 1 - k;
      sx = 1 + k * 0.8;
      rot = Math.sin(t * 10) * 0.06;
      break;
    }
    case "sleepy": {
      const T = sleepClock(B, t);
      const sl = B.sleep;
      const b = Math.sin(T * (sl === 6 ? 0.6 : sl === 2 ? 0.9 : 1.1)) * (sl === 2 ? 0.04 : 0.03);
      sy = 1 + b;
      sx = 1 - b * 0.5;
      switch (sl) {
        case 1:
          rot = 0.04;
          break;
        case 3:
          rot = -0.24 + Math.sin(T * 0.5) * 0.015;
          dx = -S * 0.025;
          break;
        case 4:
          rot = 0.24 + Math.sin(T * 0.5) * 0.015;
          dx = S * 0.025;
          break;
        case 5: {
          const d = nodDip(T);
          hop = -d * S * 0.04;
          rot = 0.05 + d * 0.05;
          break;
        }
        case 6:
          sy = 0.9 + b * 0.6;
          sx = 1.08 - b * 0.3;
          rot = 0;
          break;
        case 7:
          rot = 0.05 + Math.sin(T * 0.5) * 0.03;
          break;
        case 9:
          hop = Math.abs(Math.sin(T * 1.6)) * S * 0.015;
          dx = Math.sin(T * 0.8) * S * 0.03;
          rot = Math.sin(T * 0.8) * 0.07;
          break;
        default:
          rot = 0.08;
      }
      break;
    }
    case "oops": {
      const s = age < 0.7 ? 1 - age / 0.7 : 0;
      dx = Math.sin(t * 45) * S * 0.02 * s;
      rot = Math.sin(t * 45) * 0.04 * s;
      break;
    }
  }
  return { hop, sx, sy, rot, dx };
}

/** Eye openness 0..1: a blink every few seconds, sometimes a double. */
export function blink(t: number, seedIn?: number): number {
  "worklet";
  // Not a default parameter: the worklet compiler does not capture module
  // constants that appear only in a parameter default.
  const seed = seedIn ?? SEED;
  const period = 3.4 + seed * 1.7;
  const p = (t + seed * 7.3) % period;
  if (p < 0.15) return 1 - Math.sin((p / 0.15) * Math.PI);
  const q = (t + seed * 7.3 + 0.32) % (period * 3);
  if (q < 0.15) return 1 - Math.sin((q / 0.15) * Math.PI);
  return 1;
}

interface View {
  S: number;
  R: number;
  cx: number;
  cy: number;
  m: Motion;
  cyw: number;
  syw: number;
  cp: number;
  sp: number;
  cr: number;
  sr: number;
  facing: number;
}

interface Projected {
  sx: number;
  sy: number;
  z: number;
  f: number;
  x1: number;
  y2: number;
}

function proj3(x: number, y: number, z: number, V: View, out: Projected): Projected {
  "worklet";
  const x1 = x * V.cyw + z * V.syw;
  const z1 = -x * V.syw + z * V.cyw;
  const y2 = y * V.cp - z1 * V.sp;
  const z2 = y * V.sp + z1 * V.cp;
  const f = D / (D - z2);
  const lx = x1 * V.R * f * V.m.sx;
  const ly = -y2 * V.R * f * V.m.sy;
  out.sx = V.cx + lx * V.cr - ly * V.sr;
  out.sy = V.cy + lx * V.sr + ly * V.cr;
  out.z = z2;
  out.f = f;
  out.x1 = x1;
  out.y2 = y2;
  return out;
}

function projectAll(B: PewBody, V: View): void {
  "worklet";
  const p = B.p;
  const s = B.scr;
  const P: Projected = { sx: 0, sy: 0, z: 0, f: 1, x1: 0, y2: 0 };
  for (let i = 0; i < B.n; i++) {
    proj3(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!, V, P);
    const len = Math.hypot(P.x1, P.y2, P.z) || 1;
    const nx = P.x1 / len;
    const ny = P.y2 / len;
    const nz = P.z / len;
    const o = i * 7;
    s[o] = P.sx;
    s[o + 1] = P.sy;
    s[o + 2] = P.z;
    s[o + 3] = P.f;
    s[o + 4] = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    s[o + 5] = nx;
    s[o + 6] = ny;
  }
  B.order.sort((a, b) => s[a * 7 + 2]! - s[b * 7 + 2]!);
}

// ── the LED face ────────────────────────────────────────────

/** REM flicker for the dreaming style: darting bursts with still gaps. */
function rem(T: number): number {
  "worklet";
  return fract(T / 3.1) < 0.45 ? Math.sin(T * 23) : 0;
}

/** Snore size 0..1 for the open-mouth styles. */
function snore(T: number): number {
  "worklet";
  return 0.5 + 0.5 * Math.sin(T * 0.9);
}

/** The LED face of a sleeping Pew in style `sl`; `T` is its sleep clock. */
function sleepFace(u: number, w: number, T: number, sl: number): number {
  "worklet";
  const ey = 0.17;
  for (let side = -1; side <= 1; side += 2) {
    const ex = side * 0.32;
    if (sl === 1 && side === 1) {
      const du = (u - ex) / 0.13;
      const dw = (w - (ey - 0.03)) / 0.08;
      if (du * du + dw * dw < 1) return 1;
    } else if (sl === 2) {
      const d = Math.hypot(u - ex, w - (ey + 0.06));
      if (Math.abs(d - 0.14) < 0.05 && w < ey + 0.01) return 1;
    } else {
      const shift = sl === 7 ? rem(T) * 0.05 : 0;
      const y = sl === 6 ? ey - 0.08 : ey - 0.03;
      if (Math.abs(w - y) < 0.06 && Math.abs(u - ex - shift) < 0.15) return 1;
    }
  }
  const my = -0.22;
  switch (sl) {
    case 2: {
      const r = 0.06 + 0.06 * snore(T);
      return Math.abs(Math.hypot(u, w - my) - r) < 0.05 ? 1 : 0;
    }
    case 6:
      return Math.abs(w - my) < 0.05 && Math.abs(u) < 0.09 ? 1 : 0;
    case 7: {
      const d = Math.hypot(u, w - (my + 0.08));
      return Math.abs(d - 0.11) < 0.05 && w < my + 0.02 && Math.abs(u) < 0.11 ? 1 : 0;
    }
    case 9: {
      if (Math.hypot(u, w - my) < 0.07 + 0.03 * snore(T)) return 1;
      const len = 0.06 + 0.1 * fract(T / 5);
      return Math.abs(u - 0.09) < 0.04 && w < my - 0.04 && w > my - 0.04 - len ? 1 : 0;
    }
    default:
      return Math.hypot(u, w - my) < 0.07 ? 1 : 0;
  }
}

/** Is the LED at face coordinates (u, w) part of the face for this mood? 0..1 */
export function ledFace(u: number, w: number, mood: PewMood, open: number, t: number, sleepIn?: number): number {
  "worklet";
  if (mood === "sleepy") return sleepFace(u, w, t, sleepIn ?? 0);
  for (let side = -1; side <= 1; side += 2) {
    const ex = side * 0.32;
    const ey = 0.17;
    if (mood === "happy") {
      const d = Math.hypot(u - ex, w - (ey - 0.05));
      if (Math.abs(d - 0.13) < 0.065 && w > ey - 0.06) return 1;
    } else {
      const big = mood === "oops" ? 1.25 : 1;
      const rh = (mood === "working" ? 0.1 : 0.21) * Math.max(0.12, open) * big;
      const du = (u - ex) / (0.14 * big);
      const dw = (w - ey) / rh;
      if (du * du + dw * dw < 1) return 1;
    }
  }
  const my = -0.22;
  switch (mood) {
    case "happy": {
      const d = Math.hypot(u, w - (my + 0.1));
      return Math.abs(d - 0.2) < 0.065 && w < my + 0.08 ? 1 : 0;
    }
    case "idle": {
      const d = Math.hypot(u, w - (my + 0.09));
      return Math.abs(d - 0.15) < 0.06 && w < my + 0.03 && Math.abs(u) < 0.15 ? 1 : 0;
    }
    case "talking": {
      const o = talkOpen(t);
      const rw = 0.11;
      const rh = 0.035 + 0.08 * o;
      const du = u / rw;
      const dw = (w - (my + 0.01)) / rh;
      return du * du + dw * dw < 1 ? 1 : 0;
    }
    case "oops": {
      const d = Math.hypot(u, w - my);
      return Math.abs(d - 0.08) < 0.05 ? 1 : 0;
    }
    case "working":
      return Math.abs(w - my) < 0.055 && Math.abs(u) < 0.12 ? 1 : 0;
    case "thinking":
      return Math.abs(w - (my + u * 0.25)) < 0.055 && u > -0.05 && u < 0.16 ? 1 : 0;
  }
  return 0;
}

const C1: RGB = [0, 0, 0];
/** Seconds a face takes to dissolve into the next mood's. */
const FACE_BLEND = 0.35;

function paintLeds(B: PewBody, V: View, pal: PewPalette, st: MoodState, t: number, open: number, P: PewPainter): void {
  "worklet";
  const R = V.R;
  const base = R * Math.sqrt((4 * Math.PI) / B.n) * 0.36;
  const s = B.scr;
  const p = B.p;
  const mood = st.mood;
  let gu = clamp(B.lookX, -1, 1) * 0.08;
  let gw = -clamp(B.lookY, -1, 1) * 0.06;
  if (mood === "thinking") {
    gu = 0.1;
    gw = 0.08;
  }
  const lit = mood === "oops" ? PEW_AMBER : pal.base;
  const ledFaceOn = B.n >= LED_FACE_MIN;
  const T = mood === "sleepy" ? sleepClock(B, t) : t;
  // How much of the previous face is still showing: 1 at the change, eased to
  // 0 over FACE_BLEND seconds.
  const prev: PewMood = B.prevMood === "" ? mood : B.prevMood;
  const blendOld = prev !== mood ? 1 - smooth(0, FACE_BLEND, st.age) : 0;
  for (let oi = 0; oi < B.order.length; oi++) {
    const i = B.order[oi]!;
    const o = i * 7;
    const z = s[o + 2]!;
    const f = s[o + 3]!;
    const lam = s[o + 4]!;
    const front = (clamp(z, -1, 1) + 1) / 2;
    const px = p[i * 3]!;
    const py = p[i * 3 + 1]!;
    const pz = p[i * 3 + 2]!;
    const len = Math.hypot(px, py, pz) || 1;
    const u = px / len;
    const w = py / len;
    const facing = pz / len;
    const lat = B.lat[i]!;
    const lon = B.lon[i]!;
    const r = B.rnd[i]!;
    let on = 0;
    if (ledFaceOn && facing > 0.2) {
      on = ledFace(u - gu, w - gw, mood, open, T, B.sleep);
      // Mid-change, the old face fades out as the new one fades in, so the
      // lit dots cross-dissolve instead of the face snapping.
      if (blendOld > 0) {
        const old = ledFace(u - gu, w - gw, prev, open, prev === "sleepy" ? sleepClock(B, t) : t, B.sleep);
        on = on * (1 - blendOld) + old * blendOld;
      }
    }
    switch (mood) {
      case "idle":
        if (fract(t * 0.35 + r * 7.3) < 0.035) on = Math.max(on, 0.5);
        break;
      case "talking":
        if (fract(t * 0.6 + r * 5.1) < 0.025) on = Math.max(on, 0.45);
        break;
      case "thinking":
        on = Math.max(on, smooth(0.88, 1, fract((lon / TAU) * 2 + lat / Math.PI - t * 0.45)) * 0.75);
        break;
      case "working": {
        const scan = Math.sin(t * 2.8) * 0.95;
        const sl = Math.sin(lat) - scan;
        on = Math.max(on, Math.exp(-(sl * sl) / 0.012) * 0.9, fract((lon / TAU) * 6 + t * 1.2) < 0.07 ? 0.4 : 0);
        break;
      }
      case "happy": {
        const d = Math.acos(clamp(facing, -1, 1));
        on = Math.max(on, fract(d * 0.8 - t * 1.3) < 0.1 ? 0.8 : 0);
        break;
      }
      case "sleepy":
        on *= 0.55 + 0.2 * Math.sin(T * 1.2);
        break;
      case "oops":
        if (hash(i * 3.1 + Math.floor(t * 14)) > 0.86) on = Math.max(on, 0.8 * st.decay + 0.15);
        break;
    }
    // A small Pew has no LED face to light, so the Matrix look (a dark globe
    // with a lit face) would read as a dark ball: its body glows faintly in its
    // colour instead, which is what tells one agent's chip from another's.
    if (!ledFaceOn) on = Math.max(on, mood === "sleepy" ? SMALL_GLOW_SLEEPY : SMALL_GLOW);
    if (front < 0.5) {
      mixInto(C1, pal.off, lit, on * 0.6);
      P.dot(s[o]!, s[o + 1]!, base * f * 0.55, C1, 0.22);
      continue;
    }
    mixInto(C1, pal.off, on > 0.85 ? pal.light : lit, on);
    const k = 0.72 + 0.28 * lam;
    C1[0] *= k;
    C1[1] *= k;
    C1[2] *= k;
    P.dot(s[o]!, s[o + 1]!, base * f * (0.62 + 0.38 * front), C1, 0.35 + 0.65 * front);
    if (on > 0.45) P.glow(s[o]!, s[o + 1]!, base * f * 2.6, lit, on * 0.55 * front);
  }
}

// ── the drawn face (small sizes) ────────────────────────────

/** Points along an ellipse arc, as a polyline. */
function arc(cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number, n: number): number[] {
  "worklet";
  const out: number[] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    out.push(cx + x * c - y * s, cy + x * s + y * c);
  }
  return out;
}

function faceProj(u: number, w: number, V: View, out: Projected): Projected {
  "worklet";
  const zc = Math.sqrt(Math.max(0, 1 - u * u - w * w)) * 1.03;
  return proj3(u, w, zc, V, out);
}

function drawFace(B: PewBody, V: View, pal: PewPalette, st: MoodState, t: number, open: number, P: PewPainter, fade = 1): void {
  "worklet";
  const mood = st.mood;
  const oops = mood === "oops";
  // `fade` < 1 while this face is dissolving out (or in) across a mood change.
  const vis = smooth(0.02, 0.32, V.facing) * fade;
  if (vis <= 0) return;
  let gu = clamp(B.lookX, -1, 1) * 0.07;
  let gw = -clamp(B.lookY, -1, 1) * 0.05;
  if (mood === "thinking") {
    gu = 0.09;
    gw = 0.08;
  } else if (mood === "sleepy") {
    gu = 0;
    gw = -0.02;
  }
  const R = V.R;
  const fx = Math.max(0.3, V.facing);
  const col = oops ? PEW_AMBER : pal.eye;
  const gc = oops ? PEW_AMBER : pal.glow;
  const halo = R * 0.2;
  const rot = V.m.rot;
  const E: Projected = { sx: 0, sy: 0, z: 0, f: 1, x1: 0, y2: 0 };
  const T = sleepClock(B, t);
  for (let side = -1; side <= 1; side += 2) {
    faceProj(side * 0.3 + gu, 0.16 + gw, V, E);
    const k = E.f;
    if (mood === "happy") {
      P.line(arc(E.sx, E.sy + R * 0.06 * k, R * 0.12 * fx * k, R * 0.12 * k, rot, Math.PI * 1.1, Math.PI * 1.9, 8), R * 0.08 * k, col, vis, halo, gc);
    } else if (mood === "sleepy") {
      const sl = B.sleep;
      if (sl === 1 && side === 1) {
        P.oval(E.sx, E.sy, R * 0.08 * fx * k, R * 0.05 * k, rot, col, vis, halo, gc);
      } else if (sl === 2) {
        P.line(arc(E.sx, E.sy - R * 0.04 * k, R * 0.11 * fx * k, R * 0.09 * k, rot, Math.PI * 0.15, Math.PI * 0.85, 6), R * 0.06 * k, col, vis, halo, gc);
      } else {
        const sh = sl === 7 ? rem(T) * R * 0.04 * k : 0;
        const y = E.sy + (sl === 6 ? R * 0.06 * k : 0);
        const hw = R * (sl === 6 ? 0.12 : 0.1) * fx * k;
        P.line([E.sx - hw + sh, y, E.sx + hw + sh, y], R * (sl === 6 ? 0.045 : 0.06) * k, col, vis, halo, gc);
      }
    } else {
      const big = oops ? 1.25 : 1;
      const hh = mood === "working" ? 0.075 : 0.13;
      P.oval(E.sx, E.sy, R * 0.09 * big * fx * k, R * hh * big * Math.max(0.1, open) * k, rot, col, vis, halo, gc);
    }
  }
  faceProj(gu * 0.6, -0.2 + gw * 0.5, V, E);
  const k = E.f;
  const lw = R * 0.06 * k;
  switch (mood) {
    case "happy":
      P.line(arc(E.sx, E.sy - R * 0.08 * k, R * 0.16 * fx * k, R * 0.16 * k, rot, Math.PI * 0.2, Math.PI * 0.8, 10), lw, col, vis, halo, gc);
      break;
    case "oops":
      P.line(arc(E.sx, E.sy, R * 0.05 * fx * k, R * 0.055 * k, 0, 0, TAU, 12), lw, col, vis, halo, gc);
      break;
    case "idle":
      P.line(arc(E.sx, E.sy - R * 0.06 * k, R * 0.09 * fx * k, R * 0.09 * k, rot, Math.PI * 0.25, Math.PI * 0.75, 8), lw, col, vis, halo, gc);
      break;
    case "talking": {
      const o = talkOpen(t);
      P.oval(E.sx, E.sy, R * 0.06 * fx * k, R * (0.015 + 0.05 * o) * k, rot, col, vis, halo, gc);
      break;
    }
    case "working":
      P.line([E.sx - R * 0.06 * fx * k, E.sy, E.sx + R * 0.06 * fx * k, E.sy], lw, col, vis, halo, gc);
      break;
    case "thinking":
      P.line([E.sx - R * 0.02 * fx * k, E.sy + R * 0.01 * k, E.sx + R * 0.08 * fx * k, E.sy - R * 0.025 * k], lw, col, vis, halo, gc);
      break;
    case "sleepy":
      switch (B.sleep) {
        case 2: {
          const o = 0.04 + 0.04 * snore(T);
          P.line(arc(E.sx, E.sy, o * R * fx * k, o * 1.15 * R * k, 0, 0, TAU, 10), lw * 0.8, col, vis, halo, gc);
          break;
        }
        case 6:
          P.line([E.sx - R * 0.05 * fx * k, E.sy, E.sx + R * 0.05 * fx * k, E.sy], lw * 0.8, col, vis, halo, gc);
          break;
        case 7:
          P.line(arc(E.sx, E.sy - R * 0.05 * k, R * 0.07 * fx * k, R * 0.07 * k, rot, Math.PI * 0.25, Math.PI * 0.75, 6), lw * 0.8, col, vis, halo, gc);
          break;
        case 9: {
          P.oval(E.sx, E.sy, R * (0.04 + 0.015 * snore(T)) * k, R * (0.05 + 0.02 * snore(T)) * k, 0, col, vis, halo, gc);
          const len = R * (0.05 + 0.12 * fract(T / 5)) * k;
          const x = E.sx + R * 0.06 * fx * k;
          P.line([x, E.sy + R * 0.03 * k, x, E.sy + R * 0.03 * k + len], lw * 0.6, col, vis * 0.8, 0, gc);
          break;
        }
        default:
          P.oval(E.sx, E.sy, R * 0.035 * k, R * 0.045 * k, 0, col, vis, halo, gc);
      }
      break;
  }
}

// ── extras around the head ─────────────────────────────────

function star(x: number, y: number, r: number): number[] {
  "worklet";
  const pts: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const d = i % 2 ? r * 0.3 : r;
    pts.push(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  return pts;
}

function extras(B: PewBody, V: View, pal: PewPalette, st: MoodState, t: number, ground: number, P: PewPainter): void {
  "worklet";
  const R = V.R;
  const ax = V.cx;
  const ay = V.cy - R * 0.95 * V.m.sy;
  // Z bubbles (style 8) read at every size: they are the style.
  if (st.mood === "sleepy" && B.sleep === 8) {
    const T = sleepClock(B, t);
    for (let i = 0; i < 3; i++) {
      const p = fract(T * 0.3 + i / 3);
      const r = R * (0.14 + p * 0.16);
      const x = ax + R * 0.55 + p * R * 0.4 + Math.sin(p * 7 + i) * R * 0.08;
      const y = ay - R * 0.05 - p * R * 1.0;
      const a = (1 - p) * smooth(0, 0.15, p);
      P.line(arc(x, y, r, r, 0, 0, TAU, 12), r * 0.14, pal.glow, a * 0.55, 0, pal.glow);
      const z = r * 0.45;
      P.line([x - z, y - z, x + z, y - z, x - z, y + z, x + z, y + z], r * 0.16, pal.glow, a * 0.9, 0, pal.glow);
    }
    return;
  }
  if (V.S < EXTRAS_MIN) return;
  switch (st.mood) {
    case "thinking":
      for (let i = 0; i < 3; i++) {
        const ph = t * 3 - i * 0.6;
        P.dot(ax + R * (0.65 + i * 0.25), ay - R * (0.2 + i * 0.3) + Math.sin(ph) * R * 0.05, R * (0.055 + i * 0.035), pal.glow, 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(ph)));
      }
      break;
    case "sleepy":
      // Only the snoring styles trail the classic z's; the rest doze quietly.
      if (B.sleep !== 0 && B.sleep !== 2 && B.sleep !== 9) break;
      for (let i = 0; i < 3; i++) {
        const p = (sleepClock(B, t) * 0.42 + i / 3) % 1;
        const zs = R * (0.2 + p * 0.26) * 0.7;
        const x = ax + R * 0.5 + p * R * 0.55 + Math.sin(p * 6) * R * 0.07;
        const y = ay - p * R * 1.1;
        P.line([x, y - zs, x + zs * 0.75, y - zs, x, y, x + zs * 0.75, y], zs * 0.16, pal.glow, (1 - p) * 0.85 * smooth(0, 0.12, p), 0, pal.glow);
      }
      break;
    case "happy":
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + t * 0.5;
        const p = (t * 1.1 + i * 0.37) % 1;
        const d = R * (1.2 + p * 0.4);
        const r = R * 0.11 * Math.sin(p * Math.PI);
        if (r > 0.2) P.poly(star(ax + Math.cos(a) * d, ay + R * 0.95 + Math.sin(a) * d * 0.8, r), i % 2 ? pal.glow : WHITE, 1);
      }
      break;
    case "working":
      for (let i = 0; i < 4; i++) {
        const p = (t * 1.6 + i / 4) % 1;
        const side = i % 2 ? 1 : -1;
        P.dot(ax + side * (R * 0.9 + p * R * 0.7), ground - R * 0.08 - p * R * 0.35, R * 0.07 * (1 - p * 0.4), pal.glow, (1 - p) * 0.4);
      }
      break;
    case "oops": {
      const sc = clamp(st.age * 6, 0, 1) * (1 + 0.15 * Math.max(0, 1 - st.age * 3));
      if (sc <= 0) break;
      const x = ax + R * 0.85;
      const y = ay - R * 0.1 + Math.sin(t * 3) * R * 0.04;
      P.dot(x, y, R * 0.22 * sc, PEW_AMBER, 1);
      P.line([x, y - R * 0.11 * sc, x, y + R * 0.02 * sc], R * 0.06 * sc, AMBER_INK, 1, 0, AMBER_INK);
      P.dot(x, y + R * 0.095 * sc, R * 0.035 * sc, AMBER_INK, 1);
      break;
    }
    case "idle":
    case "talking":
      break;
  }
}

// ── a frame ─────────────────────────────────────────────────

/**
 * Paint the current pose. `advancePew` (or `settlePew`) must have run for
 * this `t` first; painting never changes the body except its draw order.
 */
export function paintPew(B: PewBody, t: number, mood: PewMood, pal: PewPalette, P: PewPainter): void {
  "worklet";
  const S = B.S;
  const st = effectiveMood(B, t, mood);
  // The body's motion blends across a mood change too (hop, squash, tilt,
  // sway), so a smile's bounce eases back into the idle sway.
  let m = motion(st.mood, t, st.age, S, B);
  const prevMood = B.prevMood;
  if (prevMood !== "" && prevMood !== st.mood && st.age < FACE_BLEND) {
    const old = motion(prevMood, t, st.age, S, B);
    const k = smooth(0, FACE_BLEND, st.age);
    m = {
      hop: old.hop + (m.hop - old.hop) * k,
      sx: old.sx + (m.sx - old.sx) * k,
      sy: old.sy + (m.sy - old.sy) * k,
      rot: old.rot + (m.rot - old.rot) * k,
      dx: old.dx + (m.dx - old.dx) * k,
    };
  }
  const R = S * SCALE;
  const ground = S * 0.86;
  const yaw = B.yaw + B.yawExtra;
  const pitch = B.pitch + B.pitchExtra;
  const V: View = {
    S,
    R,
    cx: S / 2 + m.dx,
    cy: ground - m.hop - R * 1.08 * m.sy,
    m,
    cyw: Math.cos(yaw),
    syw: Math.sin(yaw),
    cp: Math.cos(pitch),
    sp: Math.sin(pitch),
    cr: Math.cos(m.rot),
    sr: Math.sin(m.rot),
    facing: Math.cos(yaw) * Math.cos(pitch),
  };
  const open = blink(t);
  const air = clamp(m.hop / (S * 0.06), 0, 1);
  P.shadow(S / 2, ground, R * (1 - 0.25 * air), R * 0.18, 0.5 * (1 - 0.4 * air));
  projectAll(B, V);
  paintLeds(B, V, pal, st, t, open, P);
  if (B.n < LED_FACE_MIN) {
    // Small Pews draw the face as shapes: mid-change, the old face fades out
    // under the new one fading in, the same cross-dissolve as the LED face.
    const prev = B.prevMood;
    const k = prev !== "" && prev !== st.mood ? smooth(0, FACE_BLEND, st.age) : 1;
    if (k < 1 && prev !== "") drawFace(B, V, pal, { mood: prev, age: st.age, decay: st.decay }, t, open, P, 1 - k);
    drawFace(B, V, pal, st, t, open, P, k);
  }
  extras(B, V, pal, st, t, ground, P);
}
