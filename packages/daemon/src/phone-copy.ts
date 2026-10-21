/**
 * A smaller copy of a file for the phone, made once with ffmpeg and kept.
 *
 * Shared by big videos (`phone-video.ts`) and big pictures (`phone-picture.ts`):
 * the copy is keyed by the original's path, size and modification time, so the
 * next ask is instant and an edited file gets a fresh copy; concurrent asks for
 * one file share one ffmpeg run; a copy is renamed into place only when whole;
 * and only the newest few are kept. The original is never touched.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);

export interface PhoneCopyKind {
  /** Cache folder under `~/.pew2/cache`, e.g. "phone-videos". */
  folder: string;
  /** Extension of the copies, e.g. "mp4". */
  ext: string;
  /** Copies kept; the least recently used go first. */
  keep: number;
  /** For the log line: "video", "picture". */
  label: string;
}

/** Concurrent asks for one file share one run. */
const making = new Map<string, Promise<Buffer>>();

/**
 * The copy of `path`, from the cache or made now by `make`, which writes the
 * copy to the file it is given. Throws whatever `make` throws.
 */
export function phoneCopy(
  kind: PhoneCopyKind,
  original: { path: string; size: number; mtimeMs: number },
  make: (output: string) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const key = createHash("sha256")
    .update(`${original.path}|${original.size}|${Math.floor(original.mtimeMs)}`)
    .digest("hex")
    .slice(0, 32);
  const id = `${kind.folder}/${key}`;
  let pending = making.get(id);
  if (!pending) {
    pending = makeOrReuse(kind, original.size, key, make, env).finally(() => making.delete(id));
    making.set(id, pending);
  }
  return pending;
}

async function makeOrReuse(
  kind: PhoneCopyKind,
  size: number,
  key: string,
  make: (output: string) => Promise<void>,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const dir = join(env.PEW2_HOME ?? join(homedir(), ".pew2"), "cache", kind.folder);
  const copy = join(dir, `${key}.${kind.ext}`);
  try {
    const bytes = await readFile(copy);
    const now = new Date();
    await utimes(copy, now, now); // recency, for pruning
    return bytes;
  } catch {
    // Not made yet.
  }
  const started = Date.now();
  await mkdir(dir, { recursive: true });
  const partial = join(dir, `${key}.${process.pid}.part.${kind.ext}`);
  try {
    await make(partial);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
  // Renamed into place only when whole, so a crash mid-way never leaves a cut copy.
  await rename(partial, copy);
  const bytes = await readFile(copy);
  console.log(
    `[media] made a phone-sized ${kind.label}: ${(size / 1024 / 1024).toFixed(2)} MB -> ${(bytes.length / 1024 / 1024).toFixed(2)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  void prune(dir, kind);
  return bytes;
}

/** Keep the newest `keep`; a copy is cheap to make again. */
async function prune(dir: string, kind: PhoneCopyKind) {
  try {
    const pattern = new RegExp(`^[0-9a-f]{32}\\.${kind.ext}$`);
    const names = (await readdir(dir)).filter((name) => pattern.test(name));
    if (names.length <= kind.keep) return;
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })));
    dated.sort((a, b) => b.at - a.at);
    for (const { name } of dated.slice(kind.keep)) await unlink(join(dir, name));
  } catch (error) {
    console.error(`[media] could not prune phone-sized ${kind.label} copies:`, error);
  }
}

/** A sentence for a missing ffmpeg/ffprobe, or undefined for any other failure. */
export function missingTool(error: unknown, tool: string, what: string): string | undefined {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
    ? `${what} need ${tool} on the computer to make a phone-sized copy, and it was not found.`
    : undefined;
}
