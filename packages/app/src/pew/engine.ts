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
// The engine is two files: the body that simulates (`engineBody.ts`) and the
// painter that draws a frame of it (`enginePaint.ts`). This module is the
// public face the app and the tests import, so neither has to know.
export {
  PEW_AMBER,
  PEW_MOODS,
  PEW_SLEEP_STYLES,
  advancePew,
  blink,
  clamp,
  dragPew,
  gridPoints,
  hash,
  makePewBody,
  pewCount,
  pewSleepSeed,
  pewSleepStyle,
  pokePew,
  releasePew,
  settlePew,
  talkOpen,
  type PewBody,
  type PewMood,
  type PewPainter,
  type PewPalette,
  type RGB,
} from "./engineBody";
export { ledFace, paintPew } from "./enginePaint";
