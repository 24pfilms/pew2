/**
 * A phone-sized copy of a big picture.
 *
 * Orcastrator's stills run 1-3.5 MB each, and a chat can show thirty of them:
 * on 2026-10-21 opening one asked for ~30 MB at once, pictures took 20-30 s
 * each, and the link dropped under it. A phone screen shows nothing a 1600 px
 * picture does not, so a picture over `SHRINK_ABOVE` is sent as a WebP copy
 * with its longer side at most 1600 px — WebP because it keeps transparency (a
 * green-screen cut-out stays cut out) and is a fraction of a PNG's size. Made,
 * kept and reused by `phone-copy.ts`; the original is never touched.
 */
import { missingTool, phoneCopy, run, type PhoneCopyKind } from "./phone-copy.js";

/** Pictures larger than this are sent as a phone-sized copy. */
export const SHRINK_ABOVE = 600 * 1024;

const PICTURE_COPIES: PhoneCopyKind = { folder: "phone-pictures", ext: "webp", keep: 400, label: "picture" };

/**
 * The phone-sized copy of `path` (already checked to be an allowed picture),
 * made now or taken from the cache. Throws with a sentence when it cannot be
 * made; the caller decides whether the original will do instead.
 */
export function phoneSizedPicture(
  path: string,
  size: number,
  mtimeMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  return phoneCopy(
    PICTURE_COPIES,
    { path, size, mtimeMs },
    async (output) => {
      try {
        await run(
          env.PEW2_FFMPEG ?? "ffmpeg",
          [
            "-hide_banner", "-loglevel", "error", "-y", "-i", path,
            // Longer side at most 1600, never enlarged, the other in proportion.
            "-vf", "scale='if(gte(iw,ih),min(1600,iw),-1)':'if(gte(iw,ih),-1,min(1600,ih))'",
            "-frames:v", "1", "-c:v", "libwebp", "-quality", "82",
            output,
          ],
          { windowsHide: true, maxBuffer: 1024 * 1024 },
        );
      } catch (error) {
        throw new Error(missingTool(error, "ffmpeg", "Big pictures") ?? "The phone-sized copy of this picture could not be made.", {
          cause: error,
        });
      }
    },
    env,
  );
}
