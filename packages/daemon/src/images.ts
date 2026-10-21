/**
 * Reading an image off the desktop's disk for a phone that cannot see it.
 *
 * Agents display pictures by *naming a file*: an ACP `resource_link`, an
 * embedded resource, or plain markdown like `![](.gg/generated/plot.png)`. On
 * the machine running the agent that renders; on the phone it is a blank box.
 * The daemon is the only process that can read that path, so it turns it into
 * a data URI the app can paint.
 *
 * The path arrives from the *agent*, not from a trusted UI, so it is treated as
 * untrusted input: resolved, symlink-followed, then checked to be inside a root
 * the user already exposed by running a session there. Everything here is pure
 * apart from the two injected fs calls, so the containment rules are testable.
 */
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { keepDriveRoot } from "./drive-root.js";
import { findInProject } from "./find-media.js";
import { phoneSizedVideo } from "./phone-video.js";
import { phoneSizedPicture, SHRINK_ABOVE as PICTURE_SHRINK_ABOVE } from "./phone-picture.js";

/**
 * Formats React Native's `Image` can actually paint. SVG is deliberately absent:
 * it needs a renderer the app does not ship, and inlining it would produce a
 * silent empty frame rather than a picture.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/**
 * Above this the transfer costs more than the picture is worth on a phone.
 *
 * Base64 inflates by a third, so 8MB leaves roughly 11MB on the wire — inside
 * the Durable Object's 32 MiB received-message ceiling, which is the hard limit
 * the remote path would otherwise hit as a socket that simply dies. The daemon
 * ships no image library and cannot downscale, so it declines and says why.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The mime type for a path, or undefined when it is not a paintable image. */
export function imageMimeType(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

/** Containers the phone's player handles. Anything else is declined rather than sent unplayable. */
const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/**
 * Largest video sent, the same ceiling as a picture: a 7.4MB file (about 10MB
 * on the wire) was measured crossing the relay in one message in 12-15 seconds,
 * and nothing here splits a clip into pieces. A longer one is declined with its
 * size, so the user knows to fetch it another way.
 */
export const MAX_VIDEO_BYTES = 8 * 1024 * 1024;

/** The mime type for a path, or undefined when it is not a video the phone can play. */
export function videoMimeType(path: string): string | undefined {
  return VIDEO_MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

/**
 * Turn whatever the agent wrote into an absolute path.
 *
 * `file://` URLs, `~`, and paths relative to the session's working directory
 * are all normal in agent output. A URI with any other scheme is not on this
 * disk and returns undefined, so callers never accidentally read `http:` as a
 * relative filename.
 */
export function toLocalPath(
  uri: string,
  cwd: string,
  home: string = homedir(),
): string | undefined {
  const raw = uri.trim();
  if (!raw) return undefined;

  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  // Any other scheme (http:, data:, mcp:) is not a file on this machine.
  //
  // A Windows drive letter is not a scheme, though it parses as one. `C:\Users`
  // matched this, so every absolute Windows path was refused as "not a file on
  // this machine" and no agent-produced image could load there at all. A scheme
  // is at least two characters where a drive letter is exactly one — the one
  // rule that separates them without the code having to know the platform.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(raw)) return undefined;
  // A lone letter and colon is a drive only when a separator follows. `x:foo`
  // is a path relative to that drive's current directory, which is not
  // something an agent means and would resolve outside the session's cwd.
  if (/^[a-zA-Z]:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) return undefined;

  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/** True when `path` is `root` or sits underneath it. */
function isInside(path: string, root: string): boolean {
  const base = resolve(root);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * The directories an image may be read from.
 *
 * The session's own working directory is the point: the user pointed an agent
 * at that project, so its files are already in play. The temp directory is
 * included because generation tools routinely write there before anything is
 * committed. Nothing else — the pairing token is a bearer secret, and a stolen
 * one must not turn into "read any file on the machine as a picture".
 */
export function allowedImageRoots(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [resolve(cwd), resolve(tmpdir())];
  if (env.PEW2_IMAGE_ROOTS) {
    // `delimiter`, not a literal ":", for the same reason `browsableRoots` uses
    // it: a Windows path carries ":" after its drive letter, so `L:\shots` was
    // split into "L" and "\shots" and the folder the user named was never
    // allowed.
    for (const extra of env.PEW2_IMAGE_ROOTS.split(delimiter)) {
      if (extra.trim()) roots.push(resolve(extra.trim()));
    }
  }
  return roots;
}

/** An ACP image block, as the app's content parser expects to receive it. */
export interface ImageBlock {
  type: "image";
  mimeType: string;
  data: string;
}

export type HistoryImage = ImageBlock | {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
};

/**
 * Pictures inside a message read from an agent's own on-disk history.
 *
 * The JSONL formats are not ACP: an attached or generated image is stored the
 * way the underlying model API took it — Anthropic's `{ source: { data } }`, or
 * an OpenAI-style `image_url`. Local replay flattens messages to text, so
 * without this a resumed conversation silently lost every picture it contained
 * while the live stream showed them fine.
 */
export function historyImages(content: unknown): HistoryImage[] {
  if (!Array.isArray(content)) return [];
  const images: HistoryImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    // Anthropic: { type: "image", source: { type: "base64", media_type, data } }
    const source = part.source;
    if (part.type === "image" && source?.type === "base64" && typeof source.data === "string") {
      images.push({
        type: "image",
        mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
        data: source.data,
      });
      continue;
    }

    // Already ACP-shaped, which is what GG Coder stores.
    if (part.type === "image" && typeof part.data === "string") {
      images.push({
        type: "image",
        mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png",
        data: part.data,
      });
      continue;
    }

    if (part.type === "resource_link" && typeof part.uri === "string") {
      images.push({
        type: "resource_link", uri: part.uri,
        name: typeof part.name === "string" ? part.name : "Image",
        ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}),
      });
      continue;
    }

    // OpenAI: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
    const url = part.image_url?.url ?? part.imageUrl?.url;
    if (typeof url === "string") {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (match) images.push({ type: "image", mimeType: match[1]!, data: match[2]! });
      // Retain the reference, not a new fetch. The app's existing URI rules and
      // the daemon's image-file containment checks still apply when it is shown.
      else if (/^https?:\/\//i.test(url)) {
        images.push({ type: "resource_link", uri: url, name: "Image" });
      }
    }
  }
  return images;
}

/** Only explicit tool-result blocks contribute pictures, never arbitrary tool text. */
export function historyToolImages(content: unknown): HistoryImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    part?.type === "tool_result" ? historyImages(part.content) : [],
  );
}

/** A file read and inlined for the phone: a picture or a video. */
export interface LoadedImage {
  dataUri: string;
  mimeType: string;
}

/**
 * A file already open, so nothing about it can be swapped underneath.
 *
 * Size and kind are read from the descriptor rather than the path, which is
 * what makes the checks below apply to the bytes actually returned.
 */
export interface ImageFile {
  size: number;
  /** When it last changed: part of what identifies a video's phone-sized copy. */
  mtimeMs?: number;
  isFile: () => boolean;
  read: () => Promise<Buffer>;
  close: () => Promise<void>;
}

export interface ImageFs {
  realpath: (path: string) => Promise<string>;
  /** Open for reading, refusing a final component that is a symlink. */
  open: (path: string) => Promise<ImageFile>;
}

/**
 * The real filesystem. Exported so the descriptor-based read can be tested
 * against an actual symlink rather than a stub that reimplements it.
 */
export const nodeImageFs: ImageFs = {
  realpath,
  open: async (path) => {
    // O_NOFOLLOW: between the containment check and this call, the checked path
    // can be replaced with a link pointing anywhere. `realpath` proved the name
    // resolved inside an allowed root a moment ago, not that it still does.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      isFile: () => info.isFile(),
      read: () => handle.readFile(),
      close: () => handle.close(),
    };
  },
};

/**
 * Read one image and inline it, or explain why not.
 *
 * Throws with a sentence meant for the user: the app renders the failure in
 * place of the picture, and "blank box, no reason" is the bug this whole path
 * exists to remove.
 */
export function loadImage(uri: string, options: MediaOptions): Promise<LoadedImage> {
  return loadMedia(uri, options, IMAGE_KIND);
}

/**
 * Read one video and inline it, or explain why not. The same containment, the
 * same descriptor-based read; only the formats and the size ceiling differ.
 */
export function loadVideo(uri: string, options: MediaOptions): Promise<LoadedImage> {
  return loadMedia(uri, options, VIDEO_KIND);
}

type MediaOptions = { cwd: string; env?: NodeJS.ProcessEnv; fs?: ImageFs; home?: string };

/** What tells one kind of file the phone may be sent from another. */
interface MediaKind {
  mimeType: (path: string) => string | undefined;
  maxBytes: number;
  /** Finishes "'<uri>' is not ...". */
  unsupported: string;
  /**
   * What to send instead of a file over `shrinkAbove` (default `maxBytes`),
   * when there is a way to make it smaller. Absent: an oversized file is
   * refused with its size.
   */
  shrink?: (
    path: string,
    size: number,
    mtimeMs: number,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ bytes: Buffer; mimeType: string }>;
  /** Files above this go as the `shrink` copy; below `maxBytes`, the original is the fallback. */
  shrinkAbove?: number;
  /** Files never shrunk even when large (an animated GIF would lose its motion). */
  keepAsIs?: (path: string) => boolean;
}

const IMAGE_KIND: MediaKind = {
  mimeType: imageMimeType,
  maxBytes: MAX_IMAGE_BYTES,
  unsupported: "an image this app can display",
  // A big still goes as a phone-sized WebP (see `phone-picture.ts`).
  shrink: async (path, size, mtimeMs, env) => ({
    bytes: await phoneSizedPicture(path, size, mtimeMs, env),
    mimeType: "image/webp",
  }),
  shrinkAbove: PICTURE_SHRINK_ABOVE,
  keepAsIs: (path) => extname(path).toLowerCase() === ".gif",
};

const VIDEO_KIND: MediaKind = {
  mimeType: videoMimeType,
  maxBytes: MAX_VIDEO_BYTES,
  unsupported: "a video this app can play",
  // A video over the ceiling goes as a phone-sized copy (see `phone-video.ts`).
  shrink: async (path, size, mtimeMs, env) => ({
    bytes: await phoneSizedVideo(path, size, mtimeMs, env),
    mimeType: "video/mp4",
  }),
};

async function loadMedia(uri: string, options: MediaOptions, kind: MediaKind): Promise<LoadedImage> {
  const fs = options.fs ?? nodeImageFs;
  const path = toLocalPath(uri, options.cwd, options.home);
  if (!path) throw new Error(`'${uri}' is not a file on this machine`);

  const mimeType = kind.mimeType(path);
  if (!mimeType) throw new Error(`'${uri}' is not ${kind.unsupported}`);

  // Resolve symlinks *before* the containment check: `project/link -> /etc` is
  // otherwise inside the root by spelling alone.
  let real: string;
  try {
    real = resolve(keepDriveRoot(await fs.realpath(path)));
  } catch {
    // A name without its folder ("render.mp4" for `projects/x/renders/render.mp4`)
    // is looked for inside the project; the containment check below still applies.
    const raw = uri.trim();
    const relative = !isAbsolute(raw) && !raw.startsWith("~") && !raw.startsWith("file://");
    const found = relative ? await findInProject(raw, options.cwd, (name) => kind.mimeType(name) !== undefined) : undefined;
    if (!found) throw new Error(`'${uri}' was not found`);
    try {
      real = resolve(keepDriveRoot(await fs.realpath(found)));
    } catch {
      throw new Error(`'${uri}' was not found`);
    }
    console.log(`[media] found ${uri} at ${real}`);
  }

  // Roots are resolved the same way as the file. On macOS `/tmp` and
  // `/var/folders/...` are symlinks, so comparing a real path against a spelled
  // root rejects files that are plainly inside the project.
  const roots = await Promise.all(
    allowedImageRoots(options.cwd, options.env).map(async (root) => {
      try {
        return resolve(keepDriveRoot(await fs.realpath(root)));
      } catch {
        return root;
      }
    }),
  );
  if (!roots.some((root) => isInside(real, root))) {
    throw new Error(`'${uri}' is outside this session's project directory`);
  }

  // Opened once, and measured and read through that one descriptor.
  //
  // Resolving, then stat-ing, then reading re-resolved the name three times, and
  // an attacker who could write anywhere in the path only had to win the gap
  // between the check and the read — the size limit and the containment check
  // then described a different file from the one whose bytes were sent. What is
  // still resolved by name is the directories above it, which Node offers no way
  // to hold open; that needs write access to a directory inside an allowed root,
  // which is a far narrower position than replacing a file.
  let file: ImageFile;
  try {
    file = await fs.open(real);
  } catch {
    throw new Error(`'${uri}' was not found`);
  }

  try {
    if (!file.isFile()) throw new Error(`'${uri}' is not a file`);
    const tooLarge = `'${uri}' is ${Math.round(file.size / 1024 / 1024)}MB, too large to send to the app`;
    const shrinkable = kind.shrink && !kind.keepAsIs?.(real);
    if (shrinkable && file.size > (kind.shrinkAbove ?? kind.maxBytes)) {
      try {
        // The path checked above, by name: ffmpeg cannot be handed a descriptor.
        const smaller = await kind.shrink!(real, file.size, file.mtimeMs ?? 0, options.env ?? process.env);
        if (smaller.bytes.length > kind.maxBytes) throw new Error("even the phone-sized copy is too large");
        // A copy no smaller than a sendable original buys nothing.
        if (file.size > kind.maxBytes || smaller.bytes.length < file.size) {
          return { mimeType: smaller.mimeType, dataUri: `data:${smaller.mimeType};base64,${smaller.bytes.toString("base64")}` };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (file.size > kind.maxBytes) throw new Error(`${tooLarge}. ${reason}`, { cause: error });
        // Small enough to send as it is, which is what was always done.
        console.log(`[media] sending ${uri} as it is: ${reason}`);
      }
    }
    if (file.size > kind.maxBytes) throw new Error(tooLarge);

    const bytes = await file.read();
    return { mimeType, dataUri: `data:${mimeType};base64,${bytes.toString("base64")}` };
  } finally {
    // Left open, this leaks a descriptor per picture viewed — and the app fetches
    // one per image in a conversation.
    await file.close().catch(() => {});
  }
}
