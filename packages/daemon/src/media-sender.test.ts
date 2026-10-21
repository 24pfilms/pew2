/**
 * A picture or video goes to the phone as small pieces, never more than a few
 * ahead of what the phone has confirmed, so a big send cannot flood the relay.
 */
import { afterEach, expect, test } from "bun:test";
import { MediaSender } from "./media-sender.js";

const saved = {
  part: MediaSender.PART_CHARS,
  window: MediaSender.WINDOW,
  timeout: MediaSender.ACK_TIMEOUT_MS,
  active: MediaSender.MAX_ACTIVE,
};
afterEach(() => {
  MediaSender.PART_CHARS = saved.part;
  MediaSender.WINDOW = saved.window;
  MediaSender.ACK_TIMEOUT_MS = saved.timeout;
  MediaSender.MAX_ACTIVE = saved.active;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the pieces joined in order are the whole, and the closing reply says how many", async () => {
  MediaSender.PART_CHARS = 4;
  const sender = new MediaSender();
  const sent: Record<string, unknown>[] = [];
  const data = "QUJDREVGR0hJSktMTU5P"; // 20 characters -> 5 pieces
  const done = sender.send("r1", `data:image/png;base64,${data}`, (m) => sent.push(m as Record<string, unknown>), {
    t: "image",
    uri: "L:/a.png",
    mimeType: "image/png",
  });
  for (let i = 1; i <= 5; i++) {
    await tick();
    sender.ack("r1", i);
  }
  expect(await done).toBe(5);
  const parts = sent.filter((m) => m.t === "media.part");
  expect(parts.map((p) => p.index)).toEqual([0, 1, 2, 3, 4]);
  expect(parts.map((p) => p.data).join("")).toBe(data);
  expect(sent.at(-1)).toEqual({ t: "image", uri: "L:/a.png", mimeType: "image/png", requestId: "r1", parts: 5 });
});

test("never more than the window ahead of what the phone has confirmed", async () => {
  MediaSender.PART_CHARS = 1;
  MediaSender.WINDOW = 2;
  const sender = new MediaSender();
  const sent: Record<string, unknown>[] = [];
  const done = sender.send("r1", "data:video/mp4;base64,ABCDEF", (m) => sent.push(m as Record<string, unknown>), {
    t: "video",
    uri: "v.mp4",
  });
  await tick();
  expect(sent.length).toBe(2); // two out, waiting on the phone
  sender.ack("r1", 1);
  await tick();
  expect(sent.length).toBe(3);
  sender.ack("r1", 6);
  await done;
  expect(sent.filter((m) => m.t === "media.part")).toHaveLength(6);
});

test("a phone that stops confirming ends the transfer with a reason", async () => {
  MediaSender.PART_CHARS = 1;
  MediaSender.WINDOW = 1;
  MediaSender.ACK_TIMEOUT_MS = 10;
  const sender = new MediaSender();
  const sent: unknown[] = [];
  await expect(
    sender.send("r1", "data:video/mp4;base64,ABCD", (m) => sent.push(m), { t: "video", uri: "v.mp4" }),
  ).rejects.toThrow("stopped confirming");
  expect(sent).toHaveLength(1);
});

test("a confirmation for a transfer that is not running is ignored", () => {
  expect(() => new MediaSender().ack("nobody", 3)).not.toThrow();
});

test("only a couple of files go at once; the rest wait their turn, in order", async () => {
  MediaSender.PART_CHARS = 1;
  MediaSender.WINDOW = 1;
  MediaSender.MAX_ACTIVE = 2;
  const sender = new MediaSender();
  const sent: Record<string, unknown>[] = [];
  const reply = (m: unknown) => sent.push(m as Record<string, unknown>);
  const files = ["a", "b", "c", "d"].map((id) =>
    sender.send(id, "data:image/png;base64,XY", reply, { t: "image", uri: `${id}.png` }),
  );
  await tick();
  // Two started (one piece each, waiting on the phone); two wait.
  expect(new Set(sent.map((m) => m.requestId))).toEqual(new Set(["a", "b"]));
  expect(sender.load()).toEqual({ active: 2, waiting: 2 });
  sender.ack("a", 2);
  await tick();
  // "a" finished, so "c" (next in line) began, and "d" still waits.
  expect(sent.some((m) => m.requestId === "c")).toBe(true);
  expect(sent.some((m) => m.requestId === "d")).toBe(false);
  for (const id of ["b", "c", "d"]) {
    sender.ack(id, 2);
    await tick();
    sender.ack(id, 2);
  }
  sender.ack("d", 2);
  expect(await Promise.all(files)).toEqual([2, 2, 2, 2]);
});

test("the same file asked for again while on its way is not sent twice", async () => {
  MediaSender.PART_CHARS = 1;
  MediaSender.WINDOW = 1;
  const sender = new MediaSender();
  const sent: unknown[] = [];
  const first = sender.send("pic.png", "data:image/png;base64,XY", (m) => sent.push(m), { t: "image", uri: "pic.png" });
  await tick();
  expect(await sender.send("pic.png", "data:image/png;base64,XY", (m) => sent.push(m), { t: "image", uri: "pic.png" })).toBeUndefined();
  sender.ack("pic.png", 2);
  await tick();
  sender.ack("pic.png", 2);
  expect(await first).toBe(2);
});

test("a lost connection cancels what is being sent and what is waiting, and frees the queue", async () => {
  MediaSender.PART_CHARS = 1;
  MediaSender.WINDOW = 1;
  MediaSender.MAX_ACTIVE = 1;
  const sender = new MediaSender();
  const going = sender.send("a", "data:image/png;base64,XY", () => {}, { t: "image", uri: "a.png" });
  const waiting = sender.send("b", "data:image/png;base64,XY", () => {}, { t: "image", uri: "b.png" });
  await tick();
  const outcomes = Promise.allSettled([going, waiting]);
  sender.abortAll("The connection to the phone dropped.");
  const [a, b] = await outcomes;
  expect(a.status === "rejected" && String(a.reason)).toContain("dropped");
  expect(b.status === "rejected" && String(b.reason)).toContain("dropped");
  expect(sender.load()).toEqual({ active: 0, waiting: 0 });
  // And a new request goes straight away.
  const sent: unknown[] = [];
  void sender.send("c", "data:image/png;base64,X", (m) => sent.push(m), { t: "image", uri: "c.png" });
  await tick();
  expect(sent).toHaveLength(2); // the one piece and the closing reply
});
