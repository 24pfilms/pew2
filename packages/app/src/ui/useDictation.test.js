import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

let handlers;
void mock.module("./speech", () => ({
  speechAvailable: () => true,
  startDictation: async (callbacks) => {
    handlers = callbacks;
    return {
      stop: () => {
        callbacks.onTranscript("", true);
        callbacks.onEnd();
      },
      cancel: () => {},
    };
  },
}));
void mock.module("./haptics", () => ({
  haptics: { sent() {}, finished() {}, failed() {} },
}));
const { useDictation } = await import("./useDictation");

// Render the real hook with React; only native speech and haptics are stubbed.
// Server rendering is enough here: the callbacks use refs, not a rerender.
for (const base of ["", "Please"]) {
  test(`stopping dictation preserves spoken words with base ${JSON.stringify(base)}`, async () => {
    let draft = base;
    let dictation;
    function Harness() {
      dictation = useDictation({
        draft: () => draft,
        onDraftChange: (next) => { draft = next; },
        onMessage: () => {},
      });
      return null;
    }
    renderToString(createElement(Harness));
    dictation.toggle();
    await Promise.resolve();
    handlers.onTranscript("fix the login", false);
    handlers.onTranscript("fix the login bug", false);
    const expected = base ? `${base} fix the login bug` : "fix the login bug";
    expect(draft).toBe(expected);
    handlers.onTranscript("   ", false);
    expect(draft).toBe(expected);
    dictation.toggle();
    expect(draft).toBe(expected);
  });
}
