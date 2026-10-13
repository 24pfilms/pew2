import { expect, test } from "bun:test";
import { stampConsole } from "./log-time.js";

function fakeConsole() {
  const lines: unknown[][] = [];
  const record = (...args: unknown[]) => lines.push(args);
  return { lines, target: { log: record, info: record, warn: record, error: record } };
}

test("every level is stamped with the time it was written", () => {
  // A log line without a time cannot say when the relay dropped or for how
  // long, which is what the log is opened to find out.
  const { lines, target } = fakeConsole();
  stampConsole(target, () => new Date("2026-10-13T09:30:00.000Z"));

  target.log("[relay] offline", "detail");
  target.error("[ggcoder] failed");

  expect(lines).toEqual([
    ["2026-10-13T09:30:00.000Z", "[relay] offline", "detail"],
    ["2026-10-13T09:30:00.000Z", "[ggcoder] failed"],
  ]);
});

test("stamping twice does not stamp twice", () => {
  const { lines, target } = fakeConsole();
  const clock = () => new Date("2026-10-13T09:30:00.000Z");
  stampConsole(target, clock);
  stampConsole(target, clock);

  target.warn("once");

  expect(lines).toEqual([["2026-10-13T09:30:00.000Z", "once"]]);
});
