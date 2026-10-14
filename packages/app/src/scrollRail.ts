/**
 * Geometry for the Stage scroll rail (`ui/stage/StageScroll.tsx`): how long
 * the thumb is and where it sits for a given scroll position. Pure and
 * Expo-free so it is tested under bun; marked as a worklet because the rail
 * computes it on the UI thread every scroll frame.
 */

/** The thumb never shrinks below this, or a long list leaves a dot nobody can see. */
export const RAIL_MIN_THUMB = 24;

export interface RailThumb {
  /** False when everything fits: no rail at all. */
  overflows: boolean;
  /** Thumb length in points. */
  length: number;
  /** Distance of the thumb's top from the rail's top. */
  offset: number;
}

/**
 * `view` is the visible height, `content` the scrolled content's height, `y`
 * the scroll offset. Overscroll (a bounce past either end) squeezes the thumb
 * against that end instead of sliding it out of the rail.
 */
export function railThumb(view: number, content: number, y: number, minThumb: number = 24): RailThumb {
  "worklet";
  if (!(view > 0) || !(content > view + 1)) return { overflows: false, length: 0, offset: 0 };
  const full = Math.max(minThumb, Math.min(view, (view * view) / content));
  const travel = content - view;
  const over = y < 0 ? -y : y > travel ? y - travel : 0;
  const length = Math.max(minThumb / 2, full - over);
  const progress = Math.max(0, Math.min(1, y / travel));
  return { overflows: true, length, offset: progress * (view - length) };
}

/** Dots down the track: one every `pitch` points, at least two. */
export function railDots(view: number, pitch: number): number {
  "worklet";
  if (!(view > 0) || !(pitch > 0)) return 0;
  return Math.max(2, Math.floor(view / pitch));
}
