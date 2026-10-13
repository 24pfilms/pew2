/**
 * Copying a message is a long press, not a button and not native selection.
 *
 * The user asked for exactly this: no copy button on any message; hold the
 * message, then Copy. Native `selectable` would fight that hold, so message
 * text is not selectable. Read from source, like `keyboardDismissal.test.ts`:
 * there is no renderer in this suite.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function source(file: string): string {
  return readFileSync(join(import.meta.dir, file), "utf8");
}

test("a long press on any message opens the copy menu", () => {
  const turn = source("Turn.tsx");
  expect(turn).toContain("onLongPress={() => openCopyMenu(text)}");
  // A Pressable with a delay, never a gesture over the list, so scrolling wins.
  expect(turn).toContain("delayLongPress={350}");
  expect(turn).not.toContain("GestureDetector");
  // Inside a fence the block's own hold offers the code and the message.
  const markdown = source("MarkdownText.tsx");
  expect(markdown).toContain("openCopyMenu(message ?? content, content)");
});

test("no copy buttons render on any message", () => {
  expect(existsSync(join(import.meta.dir, "CopyButton.tsx"))).toBe(false);
  for (const file of ["Turn.tsx", "MarkdownText.tsx", "StreamingMarkdown.tsx"]) {
    expect(source(file)).not.toContain("CopyButton");
  }
});

test("message text is not selectable, so selection never fights the hold", () => {
  // The prop, in JSX or createElement form — not the word in a comment.
  const prop = /\bselectable\s*[:=]|<Text\s+selectable\b/;
  expect(source("MarkdownText.tsx")).not.toMatch(prop);
  expect(source("Turn.tsx")).not.toMatch(prop);
});
