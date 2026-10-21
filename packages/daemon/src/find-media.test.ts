/**
 * A picture or video the chat named without its folder is found inside the
 * project, and nowhere else.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetProjectWalks } from "./find-media.js";
import { loadImage, loadVideo } from "./images.js";

afterEach(forgetProjectWalks);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A studio-shaped project: `projects/<name>/renders/<file>`. */
function studio() {
  const root = mkdtempSync(join(tmpdir(), "pew2-find-"));
  const put = (relative: string, bytes: Buffer, at?: number) => {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    if (at) utimesSync(path, at, at);
    return path;
  };
  return { root, put };
}

test("a video named without its folder is found in the project's renders", async () => {
  const { root, put } = studio();
  put("projects/launch/renders/launch-open.mp4", Buffer.from("video-a"));
  const video = await loadVideo("launch-open.mp4", { cwd: root });
  expect(Buffer.from(video.dataUri.split(",")[1]!, "base64").toString()).toBe("video-a");
});

test("when two folders hold the name, the newest file wins", async () => {
  const { root, put } = studio();
  put("projects/old/renders/still.png", Buffer.concat([PNG, Buffer.from("old")]), 1_700_000_000);
  put("projects/new/reference/still.png", Buffer.concat([PNG, Buffer.from("new")]), 1_800_000_000);
  const image = await loadImage("still.png", { cwd: root });
  expect(Buffer.from(image.dataUri.split(",")[1]!, "base64").toString().endsWith("new")).toBe(true);
});

test("a partial folder narrows the match", async () => {
  const { root, put } = studio();
  put("projects/a/renders/cut.mp4", Buffer.from("renders"), 1_800_000_000);
  put("projects/a/drafts/cut.mp4", Buffer.from("drafts"), 1_700_000_000);
  const video = await loadVideo("drafts/cut.mp4", { cwd: root });
  expect(Buffer.from(video.dataUri.split(",")[1]!, "base64").toString()).toBe("drafts");
});

test("dependencies, hidden folders, climbing out and absolute paths are not searched", async () => {
  const { root, put } = studio();
  put("node_modules/pkg/demo.mp4", Buffer.from("x"));
  put(".cache/hidden.mp4", Buffer.from("x"));
  put("projects/a/renders/real.mp4", Buffer.from("x"));
  await expect(loadVideo("demo.mp4", { cwd: root })).rejects.toThrow(/was not found/);
  await expect(loadVideo("hidden.mp4", { cwd: root })).rejects.toThrow(/was not found/);
  // Not where it says, and a search must not wander above the project to find it.
  await expect(loadVideo("../elsewhere/real.mp4", { cwd: join(root, "projects", "a") })).rejects.toThrow(
    /was not found/,
  );
  await expect(loadVideo(join(root, "elsewhere", "real.mp4"), { cwd: root })).rejects.toThrow(/was not found/);
});
