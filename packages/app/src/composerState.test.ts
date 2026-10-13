import { test, expect } from "bun:test";
import { pressStops, showsStop } from "./composerState";

test("a working agent can be stopped", () => {
  expect(showsStop({ busy: true, loadingSession: false })).toBe(true);
});

test("loading a conversation's history is not something to stop", () => {
  // The reported bug: open an OpenCode session and the send button sits in its
  // stop state for two or three seconds without anything having been sent.
  expect(showsStop({ busy: true, loadingSession: true })).toBe(false);
});

test("an idle composer never offers to stop", () => {
  expect(showsStop({ busy: false, loadingSession: false })).toBe(false);
  expect(showsStop({ busy: false, loadingSession: true })).toBe(false);
});

test("a running turn never blocks a send", () => {
  expect(pressStops({ busy: true, canSend: true })).toBe(false);
  expect(pressStops({ busy: true, canSend: false })).toBe(true);
  expect(pressStops({ busy: false, canSend: false })).toBe(false);
});
