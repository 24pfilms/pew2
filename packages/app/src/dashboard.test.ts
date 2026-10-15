/**
 * The dashboard's numbers and sentences. The sheet only lays these out, so a
 * wrong percent or a missing "couldn't load" is caught here.
 */
import { expect, test } from "bun:test";
import { wire } from "@pew2/protocol";
import {
  DASH_LIST_ROWS,
  DASH_PAGES,
  DASH_TEXT,
  activityLabel,
  dueLabel,
  healthDots,
  isDashUnknown,
  lastSeenLabel,
  money,
  pageOutcome,
  whenLabel,
  relativeTime,
  sectionView,
  spendPercent,
  spendTone,
} from "./dashboard";

test("spend is a percent of the daily limit, clamped, and absent with no limit", () => {
  const table: [number, number | null, number | undefined][] = [
    [0.5, 2, 25],
    [3, 2, 100],
    [-1, 2, 0],
    [1, null, undefined],
    [1, 0, undefined],
  ];
  for (const [total, limit, expected] of table) expect(spendPercent(total, limit)).toBe(expected);
});

test("spend turns amber at the alert line and red at the limit", () => {
  expect(spendTone(undefined, 80)).toBe("ok");
  expect(spendTone(79, 80)).toBe("ok");
  expect(spendTone(80, 80)).toBe("attention");
  expect(spendTone(100, 80)).toBe("danger");
});

test("money shows cents", () => {
  expect(money(0.4)).toBe("$0.40");
  expect(money(12)).toBe("$12.00");
});

test("relative time reads both ways and ignores garbage", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const table: [string, string][] = [
    ["2026-10-15T12:00:20Z", "just now"],
    ["2026-10-15T11:55:00Z", "5m ago"],
    ["2026-10-15T15:00:00Z", "in 3h"],
    ["2026-10-13T12:00:00Z", "2d ago"],
    ["not a date", ""],
  ];
  for (const [iso, expected] of table) expect(relativeTime(iso, now)).toBe(expected);
});

test("last seen is the snapshot's own time, zero-padded", () => {
  const at = new Date(2026, 9, 15, 9, 5).getTime();
  expect(lastSeenLabel(at)).toBe("Last seen 09:05");
});

test("a due date is cut to the day, and no date says nothing", () => {
  expect(dueLabel("2026-10-16T09:00:00Z")).toBe("Due 2026-10-16");
  expect(dueLabel(undefined)).toBe("");
});

test("activity names the action and, when there was one, the tool", () => {
  expect(activityLabel({ timestamp: "t", type: "tool_call", tool: "web_search" })).toBe("tool_call · web_search");
  expect(activityLabel({ timestamp: "t", type: "chat" })).toBe("chat");
});

test("a section is rows, its empty sentence, or that the PC could not build it", () => {
  expect(sectionView(null, DASH_TEXT.noTasks)).toEqual({ kind: "note", text: DASH_TEXT.unavailable });
  expect(sectionView([], DASH_TEXT.noTasks)).toEqual({ kind: "note", text: DASH_TEXT.noTasks });
  const many = Array.from({ length: DASH_LIST_ROWS + 5 }, (_, i) => i);
  const view = sectionView(many, DASH_TEXT.noTasks);
  expect(view.kind === "rows" && view.rows).toEqual(many.slice(0, DASH_LIST_ROWS));
});

test("only an old daemon refusing `dash` itself ends a dashboard request", () => {
  expect(isDashUnknown("unknown_message", "Unknown message type 'dash'")).toBe(true);
  expect(isDashUnknown("unknown_message", "Unknown message type 'goals'")).toBe(false);
  expect(isDashUnknown("bad_message", "Unknown message type 'dash'")).toBe(false);
  expect(isDashUnknown("unknown_message", undefined)).toBe(false);
});

test("health dots keep one order, and a missing section has none", () => {
  const dots = healthDots({ agentCore: "ok", database: "error", openRouter: "degraded", mcpServers: "ok", uptimeMs: 1 });
  expect(dots?.map((d) => `${d.label}:${d.level}`)).toEqual(["Agent:ok", "Database:error", "OpenRouter:degraded", "MCP:ok"]);
  expect(healthDots(null)).toBeUndefined();
});

test("a page reply is shown only for the page that was asked for", () => {
  const items = [{ id: 1, title: "Trip" }];
  expect(pageOutcome({ t: "dash", requestId: "r", view: "notes", items, generatedAt: 5 }, "notes")).toEqual({ kind: "items", items, generatedAt: 5 });
  expect(pageOutcome({ t: "dash", requestId: "r", view: "projects", items }, "notes").kind).toBe("error");
});

test("an old daemon's summary reply to a page request reads as 'update pew2', not as a page", () => {
  const snapshot = { generatedAt: 1, overview: null, health: null, activity: null, tasks: null, cost: null, sessions: null, routines: null };
  expect(pageOutcome({ t: "dash", requestId: "r", snapshot }, "notes")).toEqual({ kind: "error", text: DASH_TEXT.pagesOldDaemon });
});

test("a refusal passes its sentence through, and silence falls back to the generic one", () => {
  expect(pageOutcome({ t: "dash", requestId: "r", error: "Orca is busy. Try again." }, "notes")).toEqual({ kind: "error", text: "Orca is busy. Try again." });
  expect(pageOutcome({ t: "dash", requestId: "r" }, "notes")).toEqual({ kind: "error", text: DASH_TEXT.noReply });
});

test("every listed page name is a real wire view", () => {
  expect(DASH_PAGES.map((p) => p.view)).toEqual([...wire.DASH_VIEWS]);
});

test("a date-only value is shown as written, a timestamp as relative time", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  expect(whenLabel("2026-10-20", now)).toBe("2026-10-20");
  expect(whenLabel("0026-10-20", now)).toBe("0026-10-20");
  expect(whenLabel("2026-10-15T09:00:00Z", now)).toBe("3h ago");
});
