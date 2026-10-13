import { expect, test } from "bun:test";
import { IDLE_ACTIVITY, type Activity } from "../activity";
import { receiptLength, receiptParts, revealParts, tickerLine, tickerSteps } from "./tickerText";

const busy: Activity = {
  startedAt: 0,
  speaking: false,
  tools: [
    { id: "a", title: "Read cursors.ts", kind: "read", status: "completed" },
    { id: "b", title: "advanceCursor", kind: "search", status: "in_progress" },
  ],
};

test("steps name verb and target, marking the live one", () => {
  expect(tickerSteps(busy)).toEqual([
    { id: "a", verb: "READ", target: "cursors.ts", state: "done" },
    { id: "b", verb: "SEARCH", target: "advanceCursor", state: "live" },
  ]);
});

test("working line joins the recent steps", () => {
  const line = tickerLine({ working: true, activity: busy, offline: false });
  expect(line).toEqual({ text: "READ cursors.ts · SEARCH advanceCursor …", tone: "agent", mood: "working" });
});

test("needs you beats everything, offline beats ready", () => {
  expect(tickerLine({ working: true, activity: busy, offline: true, needs: "Run tests" }).tone).toBe("attention");
  expect(tickerLine({ working: false, activity: IDLE_ACTIVITY, offline: true }).text).toBe("OFFLINE · MESSAGES WAIT");
});

test("ready names the project and changes", () => {
  expect(tickerLine({ working: false, activity: IDLE_ACTIVITY, offline: false, project: "pew2", changes: 3 }).text).toBe("READY · pew2 · +3");
  expect(tickerLine({ working: false, activity: IDLE_ACTIVITY, offline: false }).text).toBe("READY");
});

test("receipt types on segment by segment", () => {
  const parts = receiptParts({ verb: "Edited", duration: "14s", tools: 3, failed: 1 });
  expect(parts.map((p) => p.text)).toEqual(["3 STEPS", "1 FAILED", "14s"]);
  expect(revealParts(parts, 0)).toEqual([]);
  expect(revealParts(parts, 9).map((p) => p.text)).toEqual(["3 STEPS", "1"]);
  expect(revealParts(parts, receiptLength(parts))).toEqual(parts);
});

test("a goal's ticker carries Ken's latest line while idle", () => {
  const idle = { working: false, activity: IDLE_ACTIVITY, offline: false, project: "pew2" };
  expect(tickerLine({ ...idle, say: "Builder is wiring the sidebar." }).text).toBe("KEN · Builder is wiring the sidebar.");
  expect(tickerLine({ ...idle, say: "  " }).text).toBe("READY · pew2");
  expect(tickerLine({ ...idle, say: "hi", needs: "Run tests" }).tone).toBe("attention");
});
