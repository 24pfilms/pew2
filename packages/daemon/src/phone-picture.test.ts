/**
 * A big picture goes as a phone-sized WebP, made once and kept; a picture that
 * cannot be shrunk but fits under the ceiling still goes as it is.
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage } from "./images.js";
import { SHRINK_ABOVE } from "./phone-picture.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A noisy picture (noise does not compress) comfortably over `SHRINK_ABOVE`. */
function bigPicture(root: string, name: string, size: string) {
  const path = join(root, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `nullsrc=size=${size},geq=random(1)*255:128:128`,
    "-frames:v", "1", path,
  ]);
  expect(statSync(path).size).toBeGreaterThan(SHRINK_ABOVE);
  return path;
}

/** Width and height of an encoded picture, as ffprobe reads them. */
function dimensions(bytes: Buffer, root: string) {
  const file = join(root, "probe.webp");
  writeFileSync(file, bytes);
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
  ]).toString().trim();
  const [width, height] = out.split(",").map(Number);
  return { width, height };
}

test.skipIf(!hasFfmpeg)(
  "a big picture arrives as a smaller WebP, at most 1600 px, made once and reused",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pew2-bigpicture-"));
    const home = mkdtempSync(join(tmpdir(), "pew2-bigpicture-home-"));
    const big = bigPicture(root, "still.png", "2400x1200");
    const original = statSync(big);

    const env = { PEW2_HOME: home };
    const first = await loadImage(big, { cwd: root, env });
    expect(first.mimeType).toBe("image/webp");
    const bytes = Buffer.from(first.dataUri.split(",")[1]!, "base64");
    expect(bytes.length).toBeLessThan(original.size);
    expect(dimensions(bytes, root)).toEqual({ width: 1600, height: 800 });

    // Kept, and the second ask is the same copy.
    expect(readdirSync(join(home, "cache", "phone-pictures"))).toHaveLength(1);
    expect((await loadImage(big, { cwd: root, env })).dataUri).toBe(first.dataUri);

    // The original is untouched.
    expect(statSync(big).size).toBe(original.size);
    expect(statSync(big).mtimeMs).toBe(original.mtimeMs);
  },
  60_000,
);

test.skipIf(!hasFfmpeg)("a big picture under the ceiling still goes, as it is, when no copy can be made", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-plainpicture-"));
  const big = bigPicture(root, "still.png", "900x900");
  const env = { PEW2_HOME: root, PEW2_FFMPEG: join(root, "no-ffmpeg") };
  const image = await loadImage(big, { cwd: root, env });
  expect(image.mimeType).toBe("image/png");
});

test.skipIf(!hasFfmpeg)("an animated GIF is never shrunk, so it keeps its motion", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-gif-"));
  const home = mkdtempSync(join(tmpdir(), "pew2-gif-home-"));
  const gif = bigPicture(root, "loop.gif", "1400x1400");
  const image = await loadImage(gif, { cwd: root, env: { PEW2_HOME: home } });
  expect(image.mimeType).toBe("image/gif");
});
