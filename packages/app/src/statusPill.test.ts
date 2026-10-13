import { expect, test } from "bun:test";
import { checklistPill, goalPill, workerPill } from "./statusPill";

test("an idle goal has no pill; every other status names itself", () => {
  expect(goalPill("idle")).toBeUndefined();
  expect(goalPill("running")).toEqual({ label: "Running", tone: "live", pulse: true });
  expect(goalPill("briefing")?.tone).toBe("accent");
  expect(goalPill("paused")?.tone).toBe("quiet");
});

test("an interrupted goal is something to resume, not an error", () => {
  expect(goalPill("interrupted")).toEqual({ label: "Interrupted", tone: "attention" });
});

test("only things happening right now breathe", () => {
  const all = [
    ...(["briefing", "running", "paused", "interrupted"] as const).map(goalPill),
    ...(["starting", "running", "completed", "failed", "interrupted", "closed"] as const).map(workerPill),
    ...(["passed", "needs-work", "due", "not-run", "not-applicable"] as const).map(checklistPill),
  ];
  const pulsing = all.filter((p) => p?.pulse).map((p) => p!.label);
  expect(pulsing).toEqual(["Running", "Starting", "Working"]);
});

test("labels are sentence case everywhere, and red is kept for real failures", () => {
  const labels = [
    ...(["starting", "running", "completed", "failed", "interrupted", "closed"] as const).map(workerPill),
    ...(["passed", "needs-work", "due", "not-run", "not-applicable"] as const).map(checklistPill),
  ];
  for (const pill of labels) expect(pill.label[0]).toBe(pill.label[0]!.toUpperCase());
  const red = labels.filter((p) => p.tone === "danger").map((p) => p.label);
  expect(red).toEqual(["Failed", "Needs work"]);
});
