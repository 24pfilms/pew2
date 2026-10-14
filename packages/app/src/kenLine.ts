/**
 * Ken's spoken line: GG Goals ends a message with `[ken:face] words`. The chat
 * hides it and the goal header says it. Ported from gg-app's
 * `goal-ken-talk.ts` (the parser only — the farm's pacing queue is not
 * needed for one line in a header). Expo-free.
 */

export const KEN_FACES = [
  "neutral",
  "happy",
  "excited",
  "thinking",
  "focused",
  "surprised",
  "worried",
  "sad",
  "proud",
  "wink",
] as const;
export type KenFace = (typeof KEN_FACES)[number];

export interface KenSaying {
  readonly face: KenFace;
  readonly text: string;
}

/** The most characters a line may have (three short lines). */
export const KEN_LINE_MAX = 140;

const FACE_SET: ReadonlySet<string> = new Set(KEN_FACES);

// On its own line at the end; tolerant of backticks, spacing, unknown faces.
const KEN_LINE = /(?:^|\n)[ \t]*`?\[ken:([a-z]+)\]`?[ \t]*([^\n]*)[ \t]*$/i;
// A stray marker anywhere else: never shown, its words kept.
const STRAY_MARKER = /(^|\n)[ \t]*`?\[ken:[a-z]+\]`?[ \t]*/gi;
// Fallback: a line that opens the message instead.
const OPENING_KEN_LINE = /^[ \t]*`?\[ken:([a-z]+)\]`?[ \t]*([^\n]*)/i;

/** The message without Ken's line, and the line itself if it has one. */
export function splitKenLine(text: string): { readonly body: string; readonly line: KenSaying | null } {
  const match = KEN_LINE.exec(text.trimEnd());
  if (!match) {
    const opening = OPENING_KEN_LINE.exec(text.trimStart());
    return {
      body: text.replace(STRAY_MARKER, "$1"),
      line: opening ? spokenLine(opening[1], opening[2]) : null,
    };
  }
  const body = text.trimEnd().slice(0, match.index).trimEnd().replace(STRAY_MARKER, "$1");
  return { body, line: spokenLine(match[1], match[2]) };
}

function spokenLine(faceName: string | undefined, words: string | undefined): KenSaying | null {
  const name = (faceName ?? "").toLowerCase();
  const face: KenFace = FACE_SET.has(name) ? (name as KenFace) : "neutral";
  const said = clipAtWord(plainText(words ?? ""), KEN_LINE_MAX);
  return said ? { face, text: said } : null;
}

/** The message as the chat shows it. */
export function stripKenLine(text: string): string {
  return splitKenLine(text).body;
}

/** While streaming, a trailing partial `[ken:` marker is hidden too. */
export function hidePartialKenLine(text: string): string {
  const cut = /(?:^|\n)[ \t]*`?\[(?:k(?:e(?:n(?::[a-z]*)?)?)?)?$/i.exec(text);
  return cut ? text.slice(0, cut.index) : stripKenLine(text);
}

function plainText(raw: string): string {
  return raw
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Ken's latest line from a transcript: the newest agent turn that has one. */
export function latestKenSaying(turns: readonly { role: string; text: string }[]): KenSaying | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role !== "agent") continue;
    const line = splitKenLine(turn.text).line;
    if (line) return line;
  }
  return null;
}

/**
 * The transcript with Ken's lines taken out of agent bubbles. Untouched turns
 * keep their identity, so memoised cells do not re-render.
 */
export function withoutKenLines<T extends { role: string; text: string }>(turns: readonly T[]): T[] {
  return turns.map((turn) => {
    if (turn.role !== "agent" || !/\[k/i.test(turn.text)) return turn;
    const text = hidePartialKenLine(turn.text);
    return text === turn.text ? turn : { ...turn, text };
  });
}
