/**
 * Which overlays take the keyboard down, and which deliberately do not.
 *
 * There is no renderer in this suite, so these read the source. That is enough,
 * because the rule being protected is a decision about *where the call lives*,
 * not about what it computes — and the decision is not obvious enough to survive
 * on comments alone.
 *
 * The rule: an overlay that rests against the bottom edge dismisses the
 * keyboard, because that is exactly where the keyboard is and the card would
 * otherwise open behind it. An overlay anchored to a control at the top does
 * not, because switching a setting mid-sentence should not drop the draft's
 * keyboard and bounce the composer.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(file: string): string {
  return readFileSync(join(import.meta.dir, file), "utf8");
}

test("every sheet takes the keyboard down, from the one place they share", () => {
  // Sheets rest on the bottom edge. Opening one from the composer put the whole
  // card behind the keyboard: invisible, with its rows unreachable.
  //
  // Asserted on `Sheet` rather than on its callers because that is the point of
  // the shared primitive — a sheet added later inherits this instead of having
  // to remember it.
  const sheet = source("Sheet.tsx");
  expect(sheet).toContain("if (!keepKeyboard) Keyboard.dismiss()");

  // Some sheets now hold a field (the command filter, an answer of your own),
  // so dismissing on open is only half of it: the card must ride above the
  // keyboard when that field raises it, or the keyboard covers the list.
  expect(sheet).toContain("useReanimatedKeyboardAnimation");
  expect(sheet).toContain("keyboard.height.value");
});

test("tapping the transcript takes the keyboard down", () => {
  // The list asks for this with `keyboardShouldPersistTaps="handled"`, which
  // blurs on any tap a child does not claim.
  expect(source("ChatThread.tsx")).toContain('keyboardShouldPersistTaps="handled"');

  // The copy-hold wraps each turn in a Pressable, which claims the touch, so
  // the wrapper must take the keyboard down itself on a plain tap — otherwise
  // tapping away from the composer onto the conversation stops blurring.
  const turn = source("Turn.tsx");
  expect(turn).toContain("onPress={Keyboard.dismiss}");
  // The wrapper plus two controls: the thought row and the retry button.
  expect(turn.match(/<Pressable/g) ?? []).toHaveLength(3);
  expect(turn).toContain("Show thought process");
  expect(turn).toContain("Send this message again");
});

test("an anchored picker keeps the keyboard, on purpose", () => {
  // The opposite decision, and the more fragile one: it looks like an oversight,
  // so it is the one somebody would "fix". Switching model or project is not
  // leaving the conversation — dropping the keyboard there loses the draft's
  // focus and drops the composer mid-sentence.
  for (const file of ["ConfigPicker.tsx", "ProjectMenu.tsx"]) {
    expect(source(file)).not.toContain("Keyboard.dismiss");
  }
  // The model picker is a sheet now, so it has to opt out of the sheet's
  // dismissal explicitly.
  expect(source("ConfigPicker.tsx")).toContain("keepKeyboard");
});
