/**
 * The dashboard rides the wire additively: new message types, one optional
 * announcement field, and a snapshot schema that strips whatever the PC adds.
 */
import { expect, test } from "bun:test";
import { DASH_VIEWS, DashSnapshot, DashView } from "./dash.js";
import { ClientMessage, ServerMessage } from "./wire.js";

const snapshot = {
  generatedAt: 1_760_000_000_000,
  overview: { costTodayUsd: 0.42, sessionCount: 3, factCount: 10, routineCount: 2, uptimeMs: 5000 },
  health: { agentCore: "ok", database: "ok", openRouter: "degraded", mcpServers: "error", uptimeMs: 5000 },
  activity: [{ timestamp: "2026-10-15T10:00:00Z", type: "tool_call", tool: "web_search" }],
  tasks: [{ id: 1, title: "Pay rent", priority: "high", status: "pending", dueDate: "2026-10-16" }],
  cost: { totalUsd: 0.42, dailyLimitUsd: 2, monthlyLimitUsd: null, alertAtPercent: 80 },
  sessions: [{ id: "s1", name: "Morning", updatedAt: "2026-10-15T09:00:00Z" }],
  routines: [{ id: 7, name: "Digest", enabled: true, nextRunAt: "2026-10-16T07:00:00Z" }],
} satisfies DashSnapshot;

test("a dash request and its reply round-trip", () => {
  expect(ClientMessage.parse({ t: "dash", requestId: "r" })).toEqual({ t: "dash", requestId: "r" });
  const reply = ServerMessage.parse({ t: "dash", requestId: "r", snapshot });
  expect(reply).toEqual({ t: "dash", requestId: "r", snapshot });
  const failed = ServerMessage.parse({ t: "dash", requestId: "r", error: "Orca isn't running on this computer." });
  expect(failed).toEqual({ t: "dash", requestId: "r", error: "Orca isn't running on this computer." });
});

test("the request carries no parameters through to the daemon", () => {
  // Anything extra the phone puts on the frame is dropped at parse.
  expect(ClientMessage.parse({ t: "dash", requestId: "r", type: "tasks.complete", id: 1 })).toEqual({
    t: "dash",
    requestId: "r",
  });
});

test("a section that failed on the PC arrives as null, and the rest still parses", () => {
  const partial = { ...snapshot, health: null, tasks: null };
  expect(DashSnapshot.parse(partial)).toEqual(partial);
});

test("fields the PC adds by mistake never reach the phone", () => {
  const leaky = {
    ...snapshot,
    secret: "sk-123",
    activity: [{ timestamp: "t", type: "chat", summary: "private words" }],
    tasks: [{ ...snapshot.tasks[0], description: "private notes" }],
  };
  const parsed = DashSnapshot.parse(leaky);
  expect(JSON.stringify(parsed)).not.toContain("sk-123");
  expect(JSON.stringify(parsed)).not.toContain("private");
});

test("a wrong shape is refused, not guessed at", () => {
  expect(DashSnapshot.safeParse({ ...snapshot, health: { ...snapshot.health, database: "fine" } }).success).toBe(false);
  expect(DashSnapshot.safeParse({ ...snapshot, cost: { totalUsd: "1" } }).success).toBe(false);
  expect(DashSnapshot.safeParse({ generatedAt: 1 }).success).toBe(false);
});

test("an announcement parses with and without the dashboard field", () => {
  const announce = { t: "providers", machine: { id: "m", name: "pc" }, providers: [] };
  const old = ServerMessage.parse(announce);
  expect(old.t === "providers" && old.dashboard).toBeUndefined();
  const on = ServerMessage.parse({ ...announce, dashboard: { available: false, reason: "Orca is off." } });
  expect(on.t === "providers" && on.dashboard).toEqual({ available: false, reason: "Orca is off." });
});

test("every page name is accepted and nothing else is", () => {
  for (const view of DASH_VIEWS) expect(ClientMessage.safeParse({ t: "dash", requestId: "r", view }).success).toBe(true);
  expect(ClientMessage.safeParse({ t: "dash", requestId: "r" }).success).toBe(true);
  for (const view of ["settings", "chat", "", "NOTES", 5]) {
    expect(ClientMessage.safeParse({ t: "dash", requestId: "r", view }).success).toBe(false);
  }
});

test("a page view keeps titles and dates and strips body text", () => {
  const parsed = DashView.parse({
    view: "notes",
    generatedAt: 1,
    items: [{ id: 1, title: "Trip", detail: "3 words", at: "2026-10-09", content: "private body" }],
  });
  expect(parsed.items).toEqual([{ id: 1, title: "Trip", detail: "3 words", at: "2026-10-09" }]);
});

test("an old daemon's reply to a page request has no view, which the app can tell apart", () => {
  const reply = ServerMessage.parse({ t: "dash", requestId: "r", snapshot });
  expect(reply.t === "dash" && reply.view).toBeUndefined();
});

test("a task change rides the dash frame, and its reply carries the task", () => {
  const add = { t: "dash", requestId: "r", task: { action: "add", title: "Buy milk", clientId: "c1" } } as const;
  expect(ClientMessage.parse(add)).toEqual(add);
  const done = { t: "dash", requestId: "r", task: { action: "complete", id: 3 } } as const;
  expect(ClientMessage.parse(done)).toEqual(done);
  const reply = { t: "dash", requestId: "r", task: { id: 3, title: "Buy milk", priority: "medium", status: "pending" } } as const;
  expect(ServerMessage.parse(reply)).toEqual(reply);
});

test("a task change is trimmed, bounded, and limited to add and complete", () => {
  const parse = (task: unknown) => ClientMessage.safeParse({ t: "dash", requestId: "r", task }).success;
  expect(ClientMessage.parse({ t: "dash", requestId: "r", task: { action: "add", title: "  hi ", clientId: "c" } })).toMatchObject({ task: { title: "hi" } });
  expect(parse({ action: "add", title: "   ", clientId: "c" })).toBe(false);
  expect(parse({ action: "add", title: "x".repeat(201), clientId: "c" })).toBe(false);
  expect(parse({ action: "add", title: "ok" })).toBe(false);
  expect(parse({ action: "complete", id: 0 })).toBe(false);
  expect(parse({ action: "delete", id: 1 })).toBe(false);
});
