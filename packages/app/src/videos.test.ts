import { expect, test } from "bun:test";
import { expandBraces, MAX_VIDEOS_PER_MESSAGE, videoName, videosFromText } from "./videos";
import { VIDEO_CACHE_CAP_BYTES, videoCacheName, videosToEvict, type CachedVideoFile } from "./videoCachePolicy";

const paths = (text: string) => videosFromText(text).map((video) => video.src);

test("a Windows path in a closing message becomes a card", () => {
  expect(paths("Done. The clip is at L:\\_New_Projects\\Orcastrator\\renders\\smiley-v1.mp4 and it is 2 seconds.")).toEqual([
    "L:\\_New_Projects\\Orcastrator\\renders\\smiley-v1.mp4",
  ]);
  expect(paths("Saved to L:/renders/a.mov.")).toEqual(["L:/renders/a.mov"]);
});

test("a path in backticks or quotes may hold spaces", () => {
  expect(paths("Final: `C:\\Users\\me\\OneDrive\\My Videos\\beach dance.mp4`")).toEqual([
    "C:\\Users\\me\\OneDrive\\My Videos\\beach dance.mp4",
  ]);
  expect(paths('Open "D:\\goals-builds\\run 3\\out.webm" next')).toEqual(["D:\\goals-builds\\run 3\\out.webm"]);
});

test("a markdown link to a video is a card, and its text is not", () => {
  expect(paths("Watch [the render](L:\\renders\\final cut.mp4) now")).toEqual(["L:\\renders\\final cut.mp4"]);
  expect(paths("[x](<L:/renders/a b.mp4>)")).toEqual(["L:/renders/a b.mp4"]);
});

test("posix, home and file URI paths are offered", () => {
  expect(paths("Wrote /tmp/out/clip.mp4 for you")).toEqual(["/tmp/out/clip.mp4"]);
  expect(paths("see ~/videos/clip.webm")).toEqual(["~/videos/clip.webm"]);
  expect(paths("file:///L:/renders/clip.mov is ready")).toEqual(["file:///L:/renders/clip.mov"]);
});

test("a relative path counts only when it is marked off as a file", () => {
  expect(paths("It is in `renders/clip.mp4`")).toEqual(["renders/clip.mp4"]);
  // A bare filename in a sentence is not worth a card that fails when tapped.
  expect(paths("Rename clip.mp4 to something better")).toEqual([]);
  expect(paths("the renders/clip.mp4 folder")).toEqual([]);
});

test("web addresses and other files are ignored", () => {
  expect(paths("Watch https://example.com/a/clip.mp4 online")).toEqual([]);
  expect(paths("[x](https://example.com/clip.mp4)")).toEqual([]);
  expect(paths("`L:\\renders\\notes.txt` and L:\\renders\\plot.png")).toEqual([]);
  expect(paths("clip.mp4.bak at L:\\renders\\clip.mp4.bak")).toEqual([]);
  expect(paths("")).toEqual([]);
});

test("the same video named twice is one card, and a long list is capped", () => {
  expect(paths("L:\\a\\x.mp4 then `L:\\a\\x.mp4` and [x](L:/a/X.MP4)")).toEqual(["L:\\a\\x.mp4"]);
  const many = Array.from({ length: 9 }, (_, i) => `L:\\renders\\clip${i}.mp4`).join("\n");
  expect(videosFromText(many)).toHaveLength(MAX_VIDEOS_PER_MESSAGE);
});

test("videos come in the order they are written", () => {
  expect(paths("First L:\\a\\one.mp4, then `L:\\b b\\two.mov`, last [3](L:/c/three.webm)")).toEqual([
    "L:\\a\\one.mp4",
    "L:\\b b\\two.mov",
    "L:/c/three.webm",
  ]);
});

test("shorthand for a set of renders becomes one card per render", () => {
  // As Orcastrator wrote it on 2026-10-21, which was one card for a file that does not exist.
  expect(paths("- **Renders:** `renders\\launch-{open,mid,zero,end}.mp4`.")).toEqual([
    "renders\\launch-open.mp4",
    "renders\\launch-mid.mp4",
    "renders\\launch-zero.mp4",
    "renders\\launch-end.mp4",
  ]);
  expect(expandBraces("a-{x,y}-{1,2}.mp4")).toEqual(["a-x-1.mp4", "a-x-2.mp4", "a-y-1.mp4", "a-y-2.mp4"]);
  // No comma, no set: left as written.
  expect(expandBraces("L:\\{draft}\\a.mp4")).toEqual(["L:\\{draft}\\a.mp4"]);
  // Still capped like any long list.
  expect(paths("`c-{1,2,3,4,5,6}.mp4`")).toHaveLength(MAX_VIDEOS_PER_MESSAGE);
});

test("a card is titled with the file's own name", () => {
  expect(videoName("L:\\renders\\final cut.mp4")).toBe("final cut.mp4");
  expect(videoName("/tmp/out/clip.webm")).toBe("clip.webm");
  expect(videoName("clip.mov")).toBe("clip.mov");
  expect(videosFromText("`L:\\a\\one.mp4`")[0]).toEqual({ src: "L:\\a\\one.mp4", name: "one.mp4" });
});

const MB = 1024 * 1024;
const file = (name: string, mb: number, modifiedAt: number | null): CachedVideoFile => ({
  name,
  size: mb * MB,
  modifiedAt,
});

test("the cache deletes the oldest videos until it fits", () => {
  const files = [file("c.mp4", 80, 300), file("a.mp4", 80, 100), file("b.mp4", 80, 200)];
  // 240 MB against a 200 MB cap: dropping the oldest (80) leaves 160.
  expect(videosToEvict(files, 200 * MB)).toEqual(["a.mp4"]);
  expect(videosToEvict(files, 100 * MB)).toEqual(["a.mp4", "b.mp4"]);
  expect(videosToEvict(files, 500 * MB)).toEqual([]);
  expect(videosToEvict([], 200 * MB)).toEqual([]);
});

test("the video about to play is never evicted, and an unreadable date counts as oldest", () => {
  const files = [file("old.mp4", 150, 100), file("new.mp4", 150, 200)];
  expect(videosToEvict(files, 100 * MB, "old.mp4")).toEqual(["new.mp4"]);
  expect(videosToEvict([file("fresh.mp4", 120, 500), file("odd.mp4", 120, null)], 150 * MB)).toEqual(["odd.mp4"]);
  expect(VIDEO_CACHE_CAP_BYTES).toBe(200 * MB);
});

test("cached files are named by the whole path, then the video's own name", () => {
  const a = videoCacheName("L:\\renders\\final cut.mp4");
  expect(a).toMatch(/^[0-9a-z]+-final_cut\.mp4$/);
  // The same file name in another folder is another file.
  expect(videoCacheName("L:\\other\\final cut.mp4")).not.toBe(a);
  // The same path always gives the same file, so a second tap finds the first download.
  expect(videoCacheName("L:\\renders\\final cut.mp4")).toBe(a);
  // A very long name keeps its end, where the extension is.
  expect(videoCacheName("L:/x/" + "a".repeat(200) + ".mov").endsWith("a.mov")).toBe(true);
  expect(videoCacheName("L:/x/" + "a".repeat(200) + ".mov").length).toBeLessThan(75);
  expect(videoCacheName("/tmp/../etc/pass wd.mp4")).toMatch(/^[0-9a-z]+-pass_wd\.mp4$/);
});

