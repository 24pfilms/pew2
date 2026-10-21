/**
 * A phone-sized copy of a video too big to send as it is.
 *
 * Orcastrator renders run 14-34 MB, and the phone was refused anything over the
 * 8 MB ceiling with "too large to send". So a video over the ceiling is copied
 * once with ffmpeg — the longer side at most 1280 px, H.264 + AAC, a bit rate
 * worked out from its length to land under `TARGET_BYTES` — and the copy is
 * what the phone gets. Made, kept and reused by `phone-copy.ts`; the original
 * is never touched.
 */
import { missingTool, phoneCopy, run, type PhoneCopyKind } from "./phone-copy.js";

/** What a copy aims at: under the 8 MB ceiling with room for the container. */
export const TARGET_BYTES = 7 * 1024 * 1024;
/** Audio is kept, at a speech-and-music rate that costs little of the budget. */
const AUDIO_BPS = 96_000;
/** Below this the picture is mush: a video too long for it is refused, not mangled. */
const MIN_VIDEO_BPS = 150_000;

const VIDEO_COPIES: PhoneCopyKind = { folder: "phone-videos", ext: "mp4", keep: 40, label: "video" };

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
  return phoneCopy(
    VIDEO_COPIES,
    { path, size, mtimeMs },
    async (output) => {
      const ffmpeg = env.PEW2_FFMPEG ?? "ffmpeg";
      const ffprobe = env.PEW2_FFPROBE ?? "ffprobe";
      let seconds: number;
      try {
        const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], {
          windowsHide: true,
        });
        seconds = Number.parseFloat(stdout.trim());
      } catch (error) {
        throw new Error(missingTool(error, "ffprobe", "Big videos") ?? "The video could not be read to make a phone-sized copy.", {
          cause: error,
        });
      }
      const videoBps = phoneVideoBitrate(seconds);
      if (!videoBps) {
        throw new Error(
          `This video is ${Math.round(size / 1024 / 1024)}MB and ${Math.round(seconds)}s long: too long to send to the phone even shrunk.`,
        );
      }
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
            output,
          ],
          { windowsHide: true, maxBuffer: 1024 * 1024 },
        );
      } catch (error) {
        throw new Error(missingTool(error, "ffmpeg", "Big videos") ?? "The phone-sized copy of this video could not be made.", {
          cause: error,
        });
      }
    },
    env,
  );
}
