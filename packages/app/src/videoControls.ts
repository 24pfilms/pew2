/**
 * The arithmetic behind the video card's own controls: the clock, the progress
 * bar and the skip buttons. Pure and Expo-free so it is testable under bun.
 *
 * The player's built-in control bar was not used: on this phone it stuck on
 * screen over a short clip and never showed over a long one, so the card draws
 * its own, which are always where the user expects them.
 */

/** How far the back and forward buttons skip, in seconds. */
export const SEEK_STEP_SECONDS = 5;

/** `0:07`, `1:05`, `12:30`. Anything unreadable shows as `0:00`. */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Where a skip lands: never before the start, never past the end (when the end is known). */
export function seekTarget(current: number, delta: number, duration: number): number {
  const target = (Number.isFinite(current) ? current : 0) + delta;
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(target, 0), end);
}

/** How full the progress bar is, from 0 to 1. An unknown length reads as empty. */
export function progressFraction(current: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(current)) return 0;
  return Math.min(Math.max(current / duration, 0), 1);
}

/** The time a tap on the progress bar means, given how far along the bar it landed (0 to 1). */
export function fractionToSeconds(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fraction)) return 0;
  return Math.min(Math.max(fraction, 0), 1) * duration;
}

/** Widest and narrowest shapes a card is drawn in: a strange file must not make a strip or a tower. */
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.4;
/** What a card is shaped like until the video says: a vertical phone clip. */
export const DEFAULT_VIDEO_RATIO = 9 / 16;

/** Width over height for a card, from the video's own size; vertical until it is known. */
export function videoAspectRatio(width: number | undefined, height: number | undefined): number {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return DEFAULT_VIDEO_RATIO;
  }
  return Math.min(Math.max(width / height, MIN_RATIO), MAX_RATIO);
}

