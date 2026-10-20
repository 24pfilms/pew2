/**
 * A phone-sized copy of a video too big to send as it is.
 *
 * Orcastrator renders run 14-34 MB, and the phone was refused anything over the
 * 8 MB ceiling with "too large to send". So a video over the ceiling is copied
 * once with ffmpeg — the longer side at most 1280 px, H.264 + AAC, a bit rate
 * worked out from its length to land under `TARGET_BYTES` — and the copy is
 * what the phone gets. The original is never touched. Copies are kept, keyed by
 * the file's path, size and modification time, so the next tap is instant and
 * an edited video gets a fresh copy.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What a copy aims at: under the 8 MB ceiling with room for the container. */
export const TARGET_BYTES = 7 * 1024 * 1024;
/** Audio is kept, at a speech-and-music rate that costs little of the budget. */
const AUDIO_BPS = 96_000;
/** Below this the picture is mush: a video too long for it is refused, not mangled. */
const MIN_VIDEO_BPS = 150_000;
/** Copies kept; the least recently used go first. */
const KEEP_COPIES = 40;

/**
 * The video bit rate that fits `seconds` of video, with audio, into the target.
 * Undefined when the video is too long for any watchable rate.
 */
export function phoneVideoBitrate(seconds: number): number | undefined {
  if (!(seconds > 0)) return undefined;
  // 0.92: the container and rate control overshoot; aiming a little low lands under.
  const total = (TARGET_BYTES * 8 * 0.92) / seconds;
  const video = Math.floor(total - AUDIO_BPS);
  return video >= MIN_VIDEO_BPS ? video : undefined;
}

function cacheDir(env: NodeJS.ProcessEnv): string {
  return join(env.PEW2_HOME ?? join(homedir(), ".pew2"), "cache", "phone-videos");
}

/** Concurrent taps on one video share one ffmpeg run. */
const making = new Map<string, Promise<Buffer>>();

/**
 * The phone-sized copy of `path` (already checked to be an allowed video), made
 * now or taken from the cache. Throws with a sentence for the phone.
 */
export function phoneSizedVideo(
  path: string,
  size: number,
  mtimeMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const key = createHash("sha256").update(`${path}|${size}|${Math.floor(mtimeMs)}`).digest("hex").slice(0, 32);
  let pending = making.get(key);
  if (!pending) {
    pending = makeCopy(path, size, key, env).finally(() => making.delete(key));
    making.set(key, pending);
  }
  return pending;
}

async function makeCopy(path: string, size: number, key: string, env: NodeJS.ProcessEnv): Promise<Buffer> {
  const dir = cacheDir(env);
  const copy = join(dir, `${key}.mp4`);
  try {
    const bytes = await readFile(copy);
    const now = new Date();
    await utimes(copy, now, now); // recency, for pruning
    return bytes;
  } catch {
    // Not made yet.
  }

  const ffmpeg = env.PEW2_FFMPEG ?? "ffmpeg";
  const ffprobe = env.PEW2_FFPROBE ?? "ffprobe";
  const started = Date.now();
  let seconds: number;
  try {
    const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], {
      windowsHide: true,
    });
    seconds = Number.parseFloat(stdout.trim());
  } catch (error) {
    throw new Error(missingTool(error, "ffprobe") ?? "The video could not be read to make a phone-sized copy.", {
      cause: error,
    });
  }
  const videoBps = phoneVideoBitrate(seconds);
  if (!videoBps) {
    throw new Error(
      `This video is ${Math.round(size / 1024 / 1024)}MB and ${Math.round(seconds)}s long: too long to send to the phone even shrunk.`,
    );
  }

  await mkdir(dir, { recursive: true });
  const partial = join(dir, `${key}.${process.pid}.part.mp4`);
  try {
    await run(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y", "-i", path,
        // Longer side at most 1280, the other kept in proportion and even.
        "-vf", "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'",
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
        "-b:v", String(videoBps), "-maxrate", String(Math.floor(videoBps * 1.3)), "-bufsize", String(videoBps * 2),
        "-c:a", "aac", "-b:a", String(AUDIO_BPS), "-ac", "2",
        "-movflags", "+faststart",
        partial,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw new Error(missingTool(error, "ffmpeg") ?? "The phone-sized copy of this video could not be made.", {
      cause: error,
    });
  }
  // Renamed into place only when whole, so a crash mid-way never leaves a cut copy.
  await rename(partial, copy);
  const bytes = await readFile(copy);
  console.log(
    `[media] made a phone-sized copy: ${(size / 1024 / 1024).toFixed(1)} MB -> ${(bytes.length / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  void prune(dir);
  return bytes;
}

function missingTool(error: unknown, tool: string): string | undefined {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
    ? `Big videos need ${tool} on the computer to make a phone-sized copy, and it was not found.`
    : undefined;
}

/** Keep the newest `KEEP_COPIES`; a copy is cheap to make again. */
async function prune(dir: string) {
  try {
    const names = (await readdir(dir)).filter((name) => /^[0-9a-f]{32}\.mp4$/.test(name));
    if (names.length <= KEEP_COPIES) return;
    const dated = await Promise.all(
      names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })),
    );
    dated.sort((a, b) => b.at - a.at);
    for (const { name } of dated.slice(KEEP_COPIES)) await unlink(join(dir, name));
  } catch (error) {
    console.error("[media] could not prune phone-sized video copies:", error);
  }
}
