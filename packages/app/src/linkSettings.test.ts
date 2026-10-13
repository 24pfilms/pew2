import { expect, test } from "bun:test";
import {
  DEFAULT_LINK_SETTINGS,
  newApprovals,
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

test("an approval rings once, not on every re-render or reconnect", () => {
  const seen = new Set<string>();
  const ask = { requestId: "r1", sessionId: "s1", title: "Run npm test" };
  expect(newApprovals(seen, [ask])).toEqual([ask]);
  // A reconnect restates every open request; that is not a new one.
  expect(newApprovals(seen, [ask])).toEqual([]);
});

test("answered requests are forgotten, so the set never grows", () => {
  const seen = new Set<string>();
  newApprovals(seen, [
    { requestId: "r1", sessionId: "s1", title: "a" },
    { requestId: "r2", sessionId: "s2", title: "b" },
  ]);
  newApprovals(seen, [{ requestId: "r2", sessionId: "s2", title: "b" }]);
  expect([...seen]).toEqual(["r2"]);
});
