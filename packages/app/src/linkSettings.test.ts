import { expect, test } from "bun:test";
import {
  DEFAULT_LINK_SETTINGS,
  firstSighting,
  parseLinkSettings,
  shouldRing,
} from "./linkSettings";

test("nothing stored means everything on", () => {
  expect(parseLinkSettings(null)).toEqual(DEFAULT_LINK_SETTINGS);
  expect(parseLinkSettings("not json")).toEqual(DEFAULT_LINK_SETTINGS);
});

test("a stored choice survives, and a missing field falls back", () => {
  expect(parseLinkSettings(JSON.stringify({ ringFinished: false }))).toEqual({
    background: true,
    ringApprovals: true,
    ringFinished: false,
  });
  expect(parseLinkSettings(JSON.stringify({ background: "yes" })).background).toBe(true);
});

test("never rings while pew2 is on screen", () => {
  // Someone looking at the app needs no ringtone; ringing in their hand is the
  // quickest way to get the feature turned off.
  expect(shouldRing("approval", true, DEFAULT_LINK_SETTINGS)).toBe(false);
  expect(shouldRing("finished", true, DEFAULT_LINK_SETTINGS)).toBe(false);
});

test("off screen, each reason follows its own switch", () => {
  const settings = { ...DEFAULT_LINK_SETTINGS, ringFinished: false };
  expect(shouldRing("approval", false, settings)).toBe(true);
  expect(shouldRing("finished", false, settings)).toBe(false);
});

test("an approval rings once, not again when a reconnect restates it", () => {
  const seen = new Set<string>();
  expect(firstSighting(seen, "r1")).toBe(true);
  expect(firstSighting(seen, "r1")).toBe(false);
  expect(firstSighting(seen, "r2")).toBe(true);
});

test("the memory of seen approvals stays bounded", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) firstSighting(seen, `r${i}`);
  expect(seen.size).toBe(256);
  // The oldest went first; the newest is still remembered.
  expect(seen.has("r0")).toBe(false);
  expect(firstSighting(seen, "r299")).toBe(false);
});
