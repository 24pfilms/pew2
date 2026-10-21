/**
 * Finding the videos an agent mentions, and deciding which are worth a card.
 *
 * A finished render is announced the way a picture is: by naming a file on the
 * desktop, usually in the closing message ("the clip is at L:\renders\a.mp4").
 * The phone cannot read that disk, so each path becomes a tappable card that
 * asks the daemon for the bytes. Nothing is fetched until the card is tapped.
 *
 * Pure and React-free so the rules are testable. Only paths that are clearly
 * files on the desktop are offered: a web address is not, and a bare filename
 * in a sentence ("rename clip.mp4") is not worth a card that fails when tapped.
 */

/** Containers the daemon will send, and the phone's player handles. */
const EXTENSION = "(?:mp4|mov|webm)";

/** Where a path may start: a drive, `~/`, a root `/`, or a `file://` URI. */
const ABSOLUTE_START = "(?:[A-Za-z]:[\\\\/]|~/|/|file:///)";

/** At most this many cards per message: a long listing is not a gallery. */
export const MAX_VIDEOS_PER_MESSAGE = 4;

export interface ChatVideo {
  /** The path as the agent wrote it; the daemon resolves it. */
  src: string;
  /** The file's own name, shown on the card. */
  name: string;
}

/** A path inside quotes, backticks or a markdown link may hold spaces. */
const QUOTED = new RegExp("([`'\"])([^`'\"\\r\\n]+?\\." + EXTENSION + ")\\1", "gi");
const LINKED = new RegExp("\\]\\(\\s*<?([^)>\\r\\n]+?\\." + EXTENSION + ")>?\\s*\\)", "gi");
/** A bare path may not, since a space ends it. A full stop after the extension ends the sentence, not the name. */
const BARE = new RegExp(
  "(^|[^\\w/\\\\:.~-])(" + ABSOLUTE_START + "[^\\s`'\"<>()\\[\\]|*?]+?\\." + EXTENSION + ")(?!\\w|\\.\\w)",
  "gi",
);

function isWebAddress(path: string): boolean {
  // `file://` is a file on this machine; any other scheme is not.
  return /^[a-z][a-z0-9+.-]+:\/\//i.test(path) && !/^file:\/\//i.test(path);
}

/** The file name shown on a card: the last segment of the path. */
export function videoName(path: string): string {
  const clean = path.replace(/[?#].*$/, "");
  const last = clean.split(/[\\/]/).filter(Boolean).pop();
  return last ?? clean;
}

/**
 * Shell-style shorthand spelled out: `cut-{open,end}.mp4` is `cut-open.mp4`
 * and `cut-end.mp4`. Orcastrator lists a set of renders that way, and as one
 * name the card asked for a file that does not exist. Groups without a comma,
 * or nested ones, are left as written.
 */
export function expandBraces(path: string): string[] {
  const group = /\{([^{}]*,[^{}]*)\}/.exec(path);
  if (!group) return [path];
  const before = path.slice(0, group.index);
  const after = path.slice(group.index + group[0].length);
  return group[1]!.split(",").flatMap((choice) => expandBraces(before + choice.trim() + after));
}

/** The videos named in a piece of message text, in the order they appear. */
export function videosFromText(text: string): ChatVideo[] {
  if (!text || !/\.(?:mp4|mov|webm)/i.test(text)) return [];
  const found: { index: number; path: string }[] = [];

  for (const match of text.matchAll(QUOTED)) found.push({ index: match.index ?? 0, path: match[2]!.trim() });
  for (const match of text.matchAll(LINKED)) found.push({ index: match.index ?? 0, path: match[1]!.trim() });
  for (const match of text.matchAll(BARE)) {
    found.push({ index: (match.index ?? 0) + match[1]!.length, path: match[2]! });
  }

  const seen = new Set<string>();
  const videos: ChatVideo[] = [];
  for (const { path: written } of found.sort((a, b) => a.index - b.index)) {
    if (written.length > 500 || isWebAddress(written)) continue;
    for (const path of expandBraces(written)) {
      const key = path.replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      videos.push({ src: path, name: videoName(path) });
      if (videos.length >= MAX_VIDEOS_PER_MESSAGE) return videos;
    }
  }
  return videos;
}
