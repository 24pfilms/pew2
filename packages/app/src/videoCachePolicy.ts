/**
 * How much downloaded video the phone keeps.
 *
 * A tapped video is saved in the app's cache folder so a second tap plays it
 * without asking the computer again. Left alone that folder would only grow, so
 * after each download the oldest files go until the total is back under the
 * cap. Pure and Expo-free: the file calls live in `ui/videoStore.ts`.
 */

/** About twenty short clips. Android may reclaim the cache folder sooner. */
export const VIDEO_CACHE_CAP_BYTES = 200 * 1024 * 1024;

export interface CachedVideoFile {
  name: string;
  size: number;
  /** Milliseconds since the epoch; a file with none is treated as the oldest. */
  modifiedAt: number | null;
}

/**
 * The files to delete, oldest first, so what remains fits in `capBytes`.
 *
 * `keep` is never deleted, even when it alone is over the cap: it is the video
 * about to be played.
 */
export function videosToEvict(
  files: readonly CachedVideoFile[],
  capBytes: number = VIDEO_CACHE_CAP_BYTES,
  keep?: string,
): string[] {
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const evict: string[] = [];
  const oldestFirst = [...files].sort((a, b) => (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0));
  for (const file of oldestFirst) {
    if (total <= capBytes) break;
    if (file.name === keep) continue;
    evict.push(file.name);
    total -= file.size;
  }
  return evict;
}

/**
 * The file a video is cached under: a short hash of the whole path, so two
 * different `final.mp4` never share a file, then the file's own name so the
 * cache folder (and a video saved to the gallery from it) is readable.
 */
export function videoCacheName(src: string): string {
  let hash = 5381;
  for (let i = 0; i < src.length; i++) hash = ((hash * 33) ^ src.charCodeAt(i)) >>> 0;
  const last = src.replace(/[?#].*$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "video";
  // The tail is kept when it is long, because the extension is what the player and the gallery read.
  const safe = last.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-60);
  return `${hash.toString(36)}-${safe}`;
}

