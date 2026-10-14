import { expect, test } from "bun:test";
import { copyOptions } from "./messageCopy";

test("a message offers one Copy of its text exactly as displayed", () => {
  expect(copyOptions("**Done** — `npm test`")).toEqual([
    { label: "Copy", text: "**Done** — `npm test`" },
  ]);
});

test("a code block offers the block first, then the whole message", () => {
  const message = "Here:\n\n```ts\nconst a = 1;\n```";
  expect(copyOptions(message, "const a = 1;")).toEqual([
    { label: "Copy code", text: "const a = 1;" },
    { label: "Copy message", text: message },
  ]);
});

test("nothing to copy means no menu", () => {
  expect(copyOptions("   ")).toEqual([]);
  expect(copyOptions("", "")).toEqual([]);
});
