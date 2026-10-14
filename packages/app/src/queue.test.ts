import { expect, test } from "bun:test";
import { queuePreview, returnedDraft, sendsToQueue, summariseQueue } from "./queue";

test("preview is the first line, clipped", () => {
  expect(queuePreview("hello\nworld")).toBe("hello");
  expect(queuePreview("x".repeat(80))).toBe(`${"x".repeat(63)}\u2026`);
});

test("one message is shown itself, several as a count", () => {
  expect(summariseQueue([])).toEqual({ kind: "none" });
  const one = summariseQueue([{ id: "q_1", text: "fix it\nplease" }]);
  expect(one.kind === "single" && one.preview).toBe("fix it");
  expect(summariseQueue([{ id: "a", text: "a" }, { id: "b", text: "b" }])).toEqual({
    kind: "several",
    count: 2,
    label: "2 messages queued for the next turn",
  });
});

test("returned messages fill only an empty draft", () => {
  const returned = [{ id: "a", text: "one" }, { id: "b", text: " two " }];
  expect(returnedDraft(returned, "")).toBe("one\n\ntwo");
  expect(returnedDraft(returned, "  ")).toBe("one\n\ntwo");
  expect(returnedDraft(returned, "typing")).toBeUndefined();
  expect(returnedDraft([], "")).toBeUndefined();
  expect(returnedDraft(undefined, "")).toBeUndefined();
});

test("only a sent prompt into a running turn is queued", () => {
  expect(sendsToQueue({ sent: true, busy: true, loading: false })).toBe(true);
  expect(sendsToQueue({ sent: false, busy: true, loading: false })).toBe(false);
  expect(sendsToQueue({ sent: true, busy: false, loading: false })).toBe(false);
  expect(sendsToQueue({ sent: true, busy: true, loading: true })).toBe(false);
});
