/**
 * Which agent page a carousel scroll position means. Pure (no React Native),
 * so `bun test` can drive it with the positions a real slide reports.
 *
 * An arrow press slides the list to a target page. While that slide runs, the
 * scroll events pass back through the pages in between, the page being left
 * first, and following them flipped the page (and its colour and button) back
 * and forth. So while an arrow target is set, positions are ignored until the
 * slide lands on it; then the hold is released and the finger is followed again.
 */
export interface PagingHold {
  /** The arrow's page while its slide is travelling. */
  target?: number;
}

export function pageForScroll(x: number, width: number, count: number, hold: PagingHold): number | undefined {
  if (width <= 0 || count <= 0) return undefined;
  const at = Math.max(0, Math.min(count - 1, Math.round(x / width)));
  if (hold.target === undefined) return at;
  if (Math.abs(x - hold.target * width) < 1) hold.target = undefined;
  return undefined;
}
