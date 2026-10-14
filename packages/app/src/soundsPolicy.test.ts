import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chargeOffsetSeconds, levelPitch, levelSound, shouldPlay, SOUND_NAMES, REPEAT_GAP_MS } from "./soundsPolicy";

test("every sound has its file", () => {
  for (const name of SOUND_NAMES) expect(existsSync(join(import.meta.dir, "..", "assets", "sounds", `${name}.wav`))).toBe(true);
});

describe("thinking level", () => {
  test("pitch climbs across the dial whatever the number of levels", () => {
    expect(levelPitch(0, 5)).toBe(0);
    expect(levelPitch(4, 5)).toBe(4);
    expect(levelPitch(1, 3)).toBe(2);
    expect(levelPitch(5, 6)).toBe(4);
  });

  test("up sings the stop reached, the top gets the flourish, down sighs from the stop left", () => {
    expect(levelSound(0, 1, 5)).toBe("level-up-1");
    expect(levelSound(3, 4, 5)).toBe("level-max");
    expect(levelSound(4, 3, 5)).toBe("level-down-4");
    expect(levelSound(2, 2, 5)).toBeUndefined();
    expect(levelSound(0, 1, 1)).toBeUndefined();
  });
});

test("the same sound fired twice at once plays once", () => {
  expect(shouldPlay(1000, undefined)).toBe(true);
  expect(shouldPlay(1000 + REPEAT_GAP_MS - 1, 1000)).toBe(false);
  expect(shouldPlay(1000 + REPEAT_GAP_MS, 1000)).toBe(true);
  // A clock that jumps back must not mute everything.
  expect(shouldPlay(500, 1000)).toBe(true);
});

test("a resumed hold picks the charge up where it left off", () => {
  expect(chargeOffsetSeconds(0, 1600)).toBe(0);
  expect(chargeOffsetSeconds(0.5, 1600)).toBe(0.8);
  expect(chargeOffsetSeconds(2, 1600)).toBe(1.6);
});
