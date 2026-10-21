/**
 * Finds a picture or video the chat named without its folder.
 *
 * Orcastrator agents write "orcafilm-launch-v1-test2-open.mp4" when the file is
 * `projects\orcafilm-launch\renders\orcafilm-launch-v1-test2-open.mp4`; read
 * against the project folder that name does not exist, and on 2026-10-21 every
 * such video showed "not found". So a relative name that is not where it says
 * is looked for inside the project: a bounded walk (no symlinked folders, no
 * `node_modules`, no dot-folders), the newest match winning. One walk serves
 * every name asked for in the next minute, since a chat asks for many at once.
 * The caller still checks the match is inside the project, as for any path.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, join, normalize, resolve, sep } from "node:path";

/** Deep enough for `projects/<name>/renders/<file>` with room to spare. */
const MAX_DEPTH = 5;
/** A ceiling on the walk; Orcastrator is ~1,600 folders to this depth. */
const MAX_DIRS = 5000;
/** How long one walk answers for, before files made since are looked for again. */
const FRESH_MS = 60_000;
/** A name not found is looked for again once the last walk is this old. */
const RECHECK_MS = 5_000;

type Index = Map<string, string[]>;
const indexes = new Map<string, { at: number; index: Promise<Index> }>();

/**
 * The newest file under `cwd` whose path ends with `relative`, or undefined.
 * `isMedia` says which file names are worth remembering.
 */
export async function findInProject(
  relative: string,
  cwd: string,
  isMedia: (name: string) => boolean,
): Promise<string | undefined> {
  const wanted = normalize(relative).replace(/^(\.[\\/])+/, "");
  const name = basename(wanted);
  if (!name || wanted.split(/[\\/]/).includes("..")) return undefined;

  const root = resolve(cwd);
  const matches = async (maxAge: number) => {
    let entry = indexes.get(root);
    if (!entry || Date.now() - entry.at > maxAge) {
      entry = { at: Date.now(), index: walk(root, isMedia) };
      indexes.set(root, entry);
    }
    return ((await entry.index).get(name.toLowerCase()) ?? []).filter((path) =>
      (sep + path).toLowerCase().endsWith((sep + wanted).toLowerCase()),
    );
  };
  let candidates = await matches(FRESH_MS);
  // Not there: perhaps made since the walk (a render the agent just finished).
  if (candidates.length === 0) candidates = await matches(RECHECK_MS);
  if (candidates.length <= 1) return candidates[0];
  const dated = await Promise.all(
    candidates.map(async (path) => ({ path, at: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0 })),
  );
  return dated.sort((a, b) => b.at - a.at)[0]!.path;
}

/** Media file names under `root`, lower-cased, to every path holding one. */
async function walk(root: string, isMedia: (name: string) => boolean): Promise<Index> {
  const index: Index = new Map();
  let level = [root];
  let visited = 0;
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (++visited > MAX_DIRS) return index;
      // A folder that cannot be read is skipped; the rest of the project still counts.
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") next.push(join(dir, entry.name));
        } else if (entry.isFile() && isMedia(entry.name)) {
          const key = entry.name.toLowerCase();
          index.set(key, [...(index.get(key) ?? []), join(dir, entry.name)]);
        }
      }
    }
    level = next;
  }
  return index;
}

/** For tests: forget every walk. */
export function forgetProjectWalks() {
  indexes.clear();
}
