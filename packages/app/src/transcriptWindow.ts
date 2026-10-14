/**
 * The transcript's render window: which tail of a conversation is on screen.
 *
 * All turns are in memory; this only decides how many of them the list mounts.
 * A window is a fixed `start` index into the turns, not "the last N": a
 * streamed reply or a new turn appends below without pushing an older one out
 * on every chunk. Only once the tail outgrows its pages by a whole page does
 * the start jump forward, one page at a time, far above the reader.
 */

export const TRANSCRIPT_PAGE = 50;

export interface TranscriptWindow {
  /** Which conversation the window belongs to; another one resets it. */
  readonly session: string | undefined;
  /** Index of the first visible turn. */
  readonly start: number;
  /** Pages the reader has asked for (1 + each "load earlier"). */
  readonly pages: number;
}

/** The window for `total` turns of `session`, carried on from `prev`. */
export function nextWindow(prev: TranscriptWindow | undefined, session: string | undefined, total: number): TranscriptWindow {
  const fresh = (): TranscriptWindow => ({ session, start: Math.max(0, total - TRANSCRIPT_PAGE), pages: 1 });
  if (!prev || prev.session !== session) return fresh();
  // Turns shrank under us (a reload): start again rather than point past the end.
  if (prev.start > total) return fresh();
  const limit = TRANSCRIPT_PAGE * (prev.pages + 1);
  if (total - prev.start > limit) {
    return { ...prev, start: Math.max(0, total - TRANSCRIPT_PAGE * prev.pages) };
  }
  return prev;
}

/** Reveal one more page above. */
export function loadEarlier(window: TranscriptWindow): TranscriptWindow {
  if (window.start === 0) return window;
  return { ...window, start: Math.max(0, window.start - TRANSCRIPT_PAGE), pages: window.pages + 1 };
}

/** The visible tail and how many turns sit above it. */
export function windowTurns<T>(turns: readonly T[], window: TranscriptWindow): { visible: T[]; earlier: number } {
  const start = Math.min(window.start, turns.length);
  return { visible: turns.slice(start), earlier: start };
}
