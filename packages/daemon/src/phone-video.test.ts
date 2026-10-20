/**
 * A video over the phone's ceiling goes as a phone-sized copy, made once and
 * kept; the original is never touched.
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_VIDEO_BYTES, loadVideo } from "./images.js";
import { phoneVideoBitrate, TARGET_BYTES } from "./phone-video.js";

test("the bit rate fits the video into the target, and a video too long for a watchable rate is refused", () => {
  const rate = phoneVideoBitrate(15)!;
  expect(rate).toBeGreaterThan(1_000_000);
  expect(((rate + 96_000) * 15) / 8).toBeLessThan(TARGET_BYTES);
  expect(phoneVideoBitrate(3600)).toBeUndefined();
  expect(phoneVideoBitrate(0)).toBeUndefined();
  expect(phoneVideoBitrate(Number.NaN)).toBeUndefined();
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!hasFfmpeg)(
  "a video over the ceiling arrives as a playable copy under it, made once and reused",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pew2-bigvideo-"));
    const home = mkdtempSync(join(tmpdir(), "pew2-bigvideo-home-"));
    const big = join(root, "render.mp4");
    // A 6 s 1080p clip at a wasteful rate: comfortably over 8 MB.
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", "6", "-c:v", "libx264", "-b:v", "16M", "-c:a", "aac", "-shortest", big,
    ]);
    const original = statSync(big);
    expect(original.size).toBeGreaterThan(MAX_VIDEO_BYTES);

    const env = { PEW2_HOME: home };
    const first = await loadVideo(big, { cwd: root, env });
    expect(first.mimeType).toBe("video/mp4");
    const bytes = Buffer.from(first.dataUri.split(",")[1]!, "base64");
    expect(bytes.length).toBeLessThanOrEqual(MAX_VIDEO_BYTES);
    expect(bytes.subarray(4, 8).toString()).toBe("ftyp");

    // Kept, and the second ask is the same copy.
    const copies = readdirSync(join(home, "cache", "phone-videos"));
    expect(copies).toHaveLength(1);
    const again = await loadVideo(big, { cwd: root, env });
    expect(again.dataUri).toBe(first.dataUri);

    // The original is untouched.
    expect(statSync(big).size).toBe(original.size);
    expect(statSync(big).mtimeMs).toBe(original.mtimeMs);
  },
  60_000,
);

test("a file over the ceiling that ffmpeg cannot read is refused with its size and why", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-badvideo-"));
  const home = mkdtempSync(join(tmpdir(), "pew2-badvideo-home-"));
  const fake = join(root, "broken.mp4");
  writeFileSync(fake, Buffer.alloc(MAX_VIDEO_BYTES + 1024, 1));
  await expect(loadVideo(fake, { cwd: root, env: { PEW2_HOME: home } })).rejects.toThrow(/too large to send to the app\. /);
});
