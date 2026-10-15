/**
 * Keeping a video the computer sent, and putting it in the gallery.
 *
 * The daemon answers a tap with the whole clip as a data URI. It is written to
 * a file in the app's cache folder straight away (the player needs a file, and
 * a base64 string of megabytes should not sit in React state), then the folder
 * is trimmed to its cap, oldest first. Saving to the gallery copies from that
 * file, so it never needs a second trip to the computer.
 *
 * This module binds the native SDKs; the naming and trimming rules live in the
 * Expo-free `videoCachePolicy.ts` so they stay testable.
 */
import { Directory, File, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { parseDataUri } from "../saveImage";
import {
  VIDEO_CACHE_CAP_BYTES,
  videoCacheName,
  videosToEvict,
  type CachedVideoFile,
} from "../videoCachePolicy";
import type { SaveResult } from "./imageSaver";

export interface StoredVideo {
  /** A `file:///` URI the player and the gallery can read. */
  uri: string;
  mimeType: string;
}

function cacheDirectory(): Directory {
  const directory = new Directory(Paths.cache, "pew2-videos");
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

/** Delete the oldest cached videos until the folder fits its cap; `keep` is the one about to play. */
function trimCache(directory: Directory, keep: string): void {
  try {
    const files: CachedVideoFile[] = [];
    for (const entry of directory.list()) {
      if (entry instanceof File) {
        files.push({
          name: entry.uri.split("/").pop() ?? "",
          size: entry.size,
          modifiedAt: entry.modificationTime,
        });
      }
    }
    for (const name of videosToEvict(files, VIDEO_CACHE_CAP_BYTES, keep)) {
      new File(directory, name).delete();
    }
  } catch (error) {
    // Housekeeping: a failed trim must not fail the video the user just asked for.
    console.warn("[pew2] could not trim the video cache", error);
  }
}

/** Write a video from the daemon's data URI into the cache folder. */
export async function storeVideo(src: string, dataUri: string): Promise<StoredVideo> {
  const parsed = parseDataUri(dataUri);
  if (!parsed || !parsed.mimeType.startsWith("video/")) {
    throw new Error("Your computer sent something that is not a video");
  }
  const directory = cacheDirectory();
  const name = videoCacheName(src);
  const file = new File(directory, name);
  file.create({ overwrite: true });
  file.write(parsed.base64, { encoding: "base64" });
  trimCache(directory, name);
  return { uri: file.uri, mimeType: parsed.mimeType };
}

/**
 * Save a cached video to the gallery, asking for permission if needed.
 *
 * Write-only, as for pictures: pew2 puts videos in and never reads the library.
 * A refusal falls back to the share sheet rather than losing the video.
 */
export async function saveVideoToDevice(video: StoredVideo): Promise<SaveResult> {
  try {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(video.uri, { mimeType: video.mimeType });
        return { status: "shared" };
      }
      return { status: "denied" };
    }
    await MediaLibrary.saveToLibraryAsync(video.uri);
    return { status: "saved" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not save this video",
    };
  }
}
