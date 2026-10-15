/**
 * The daemon's half of the phone dashboard, against a real pipe server that
 * behaves like Orca's agent-core: newline-delimited JSON, broadcasts to every
 * client, and an answer carrying the request's `requestId`.
 */
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { wire } from "@pew2/protocol";
import { handleMessage } from "./handler.js";
import { Daemon } from "./index.js";
import { DASH_ERRORS, MAX_REPLY_BYTES, OrcaDash, orcaDashFromEnv, orcaPipePath } from "./orcaDash.js";

const snapshot = {
  generatedAt: 1_760_000_000_000,
  overview: { costTodayUsd: 0.42, sessionCount: 3, factCount: 10, routineCount: 2, uptimeMs: 5000 },
  health: { agentCore: "ok", database: "ok", openRouter: "ok", mcpServers: "ok", uptimeMs: 5000 },
  activity: [{ timestamp: "2026-10-15T10:00:00Z", type: "tool_call", tool: "web_search" }],
  tasks: [{ id: 1, title: "Pay rent", priority: "high", status: "pending" }],
  cost: { totalUsd: 0.42, dailyLimitUsd: 2, monthlyLimitUsd: null, alertAtPercent: 80 },
  sessions: [{ id: "s1", name: "Morning", updatedAt: "2026-10-15T09:00:00Z" }],
  routines: [{ id: 7, name: "Digest", enabled: true }],
} satisfies wire.DashSnapshot;

type Respond = (request: { type: string; requestId: string }, socket: Socket) => void;

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function pipePath(): string {
  const name = `pew2-dash-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

/** A fake agent-core. Records every raw line written to it and every connection. */
async function fakeOrca(respond: Respond) {
  const path = pipePath();
  const lines: string[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    // agent-core greets every client before anything else.
    socket.write(`${JSON.stringify({ event: "connected", version: "1.0.0", sessionCount: 0 })}\n`);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        lines.push(line);
        respond(JSON.parse(line), socket);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, lines, connections: () => connections };
}

const send = (socket: Socket, value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
const answer = (requestId: string, data: unknown) => ({ ok: true, data, requestId, durationMs: 1 });
const refusal = (requestId: string, code: string, retryable = false) => ({
  ok: false,
  error: { code, message: "raw agent-core text", retryable },
  requestId,
  durationMs: 1,
});
const quiet = (path: string, extra: Partial<ConstructorParameters<typeof OrcaDash>[0]> = {}) =>
  new OrcaDash({ pipePath: path, log: () => {}, ...extra });

test("a matching reply returns the parsed snapshot", async () => {
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, snapshot)));
  expect(await quiet(orca.path).snapshot()).toEqual({ ok: true, snapshot });
});

test("the request written to the pipe is exactly the constant", async () => {
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, snapshot)));
  await quiet(orca.path).snapshot();
  expect(orca.lines).toHaveLength(1);
  const written = JSON.parse(orca.lines[0] ?? "");
  expect(Object.keys(written).sort()).toEqual(["requestId", "type"]);
  expect(written.type).toBe("phone.dash.snapshot");
});

test("broadcast lines before and after the reply are ignored", async () => {
  const orca = await fakeOrca((req, socket) => {
    send(socket, { event: "chat.token", sessionId: "s", text: "private words" });
    send(socket, answer("someone-else", { ...snapshot, generatedAt: 1 }));
    send(socket, answer(req.requestId, snapshot));
    send(socket, { event: "heartbeat", uptimeMs: 1 });
  });
  expect(await quiet(orca.path).snapshot()).toEqual({ ok: true, snapshot });
});

test("unknown keys in the reply are stripped", async () => {
  const orca = await fakeOrca((req, socket) =>
    send(socket, answer(req.requestId, { ...snapshot, secret: "sk-123", tasks: [{ ...snapshot.tasks[0], notes: "private" }] })),
  );
  const result = await quiet(orca.path).snapshot();
  expect(result).toEqual({ ok: true, snapshot });
});

test("each failure maps to a sentence for the phone", async () => {
  const missing = quiet(pipePath());
  expect(await missing.snapshot()).toEqual({ ok: false, error: DASH_ERRORS.notRunning });

  const silent = await fakeOrca(() => {});
  expect(await quiet(silent.path, { timeoutMs: 100 }).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.timeout });

  const huge = await fakeOrca((req, socket) =>
    send(socket, answer(req.requestId, { ...snapshot, tasks: [{ ...snapshot.tasks[0], title: "x".repeat(MAX_REPLY_BYTES) }] })),
  );
  expect(await quiet(huge.path).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.unreadable });

  const garbled = await fakeOrca((req, socket) => socket.write(`{"requestId":"${req.requestId}", nope\n`));
  expect(await quiet(garbled.path).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.unreadable });

  const wrong = await fakeOrca((req, socket) => send(socket, answer(req.requestId, { generatedAt: "today" })));
  expect(await quiet(wrong.path).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.unreadable });

  const off = await fakeOrca((req, socket) => send(socket, refusal(req.requestId, "TOOL_PERMISSION_DENIED")));
  expect(await quiet(off.path).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.switchedOff });

  const old = await fakeOrca((req, socket) => send(socket, refusal(req.requestId, "DATA_NOT_FOUND")));
  expect(await quiet(old.path).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.orcaTooOld });

  // Running, but hung up mid-request: not "isn't running".
  const dropped = await fakeOrca((_req, socket) => socket.end());
  expect(await quiet(dropped.path).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.failed });
});

test("a flood of broadcasts aborts the request rather than buffering it", async () => {
  const orca = await fakeOrca((_req, socket) => {
    for (let i = 0; i < 400; i += 1) send(socket, { event: "chat.token", sessionId: "s", text: "y".repeat(1000) });
  });
  expect(await quiet(orca.path).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.unreadable });
});

test("a rate-limited answer is retried once, then reported as busy", async () => {
  let asked = 0;
  const flaky = await fakeOrca((req, socket) => {
    asked += 1;
    send(socket, asked === 1 ? refusal(req.requestId, "DATA_VALIDATION", true) : answer(req.requestId, snapshot));
  });
  expect(await quiet(flaky.path, { retryDelayMs: 10 }).snapshot()).toEqual({ ok: true, snapshot });
  expect(flaky.connections()).toBe(2);

  const busy = await fakeOrca((req, socket) => send(socket, refusal(req.requestId, "DATA_VALIDATION", true)));
  expect(await quiet(busy.path, { retryDelayMs: 10 }).snapshot()).toEqual({ ok: false, error: DASH_ERRORS.busy });
  expect(busy.connections()).toBe(2);
});

test("concurrent requests share one connection, and a fresh snapshot is reused", async () => {
  const orca = await fakeOrca((req, socket) => setTimeout(() => send(socket, answer(req.requestId, snapshot)), 20));
  let clock = 1_000;
  const dash = quiet(orca.path, { now: () => clock });

  const [a, b] = await Promise.all([dash.snapshot(), dash.snapshot()]);
  expect(a).toEqual({ ok: true, snapshot });
  expect(b).toEqual(a);
  expect(orca.connections()).toBe(1);

  clock += 1_999;
  await dash.snapshot();
  expect(orca.connections()).toBe(1);

  clock += 1;
  await dash.snapshot();
  expect(orca.connections()).toBe(2);
});

test("only PEW2_ORCA_DASHBOARD=1 turns the dashboard on", () => {
  expect(orcaDashFromEnv({})).toBeUndefined();
  expect(orcaDashFromEnv({ PEW2_ORCA_DASHBOARD: "true" })).toBeUndefined();
  expect(orcaDashFromEnv({ PEW2_ORCA_DASHBOARD: "1" })).toBeInstanceOf(OrcaDash);
  expect(orcaPipePath("ken", "win32")).toBe("\\\\.\\pipe\\orca-zero-viva-ken");
  expect(orcaPipePath("ken", "linux")).toBe("/tmp/orca-zero-viva-ken.sock");
});

// ── Through the handler ─────────────────────────────────────

async function dashReply(daemon: Daemon, extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown>[] = [];
  await handleMessage(JSON.stringify({ t: "dash", requestId: "r1", ...extra }), {
    daemon,
    reply: (m) => out.push(m as Record<string, unknown>),
    broadcast: (m) => out.push(m as Record<string, unknown>),
  });
  return out;
}

function announced(daemon: Daemon) {
  const sent: Record<string, unknown>[] = [];
  daemon.attach((m) => sent.push(m as Record<string, unknown>));
  (daemon as unknown as { announceProviders(): void }).announceProviders();
  return sent.findLast((m) => m.t === "providers");
}

test("an unknown type is refused naming the type, which is how the app spots an old daemon", async () => {
  const daemon = new Daemon({ id: "t", name: "t" }, false, {});
  const out: Record<string, unknown>[] = [];
  await handleMessage(JSON.stringify({ t: "not-a-thing", requestId: "r1" }), {
    daemon,
    reply: (m) => out.push(m as Record<string, unknown>),
    broadcast: (m) => out.push(m as Record<string, unknown>),
  });
  expect(out).toEqual([{ t: "error", code: "unknown_message", message: "Unknown message type 'not-a-thing'" }]);
});

test("with the env var unset, nothing is announced and dash says it is off", async () => {
  const daemon = new Daemon({ id: "t", name: "t" }, false, {});
  expect(announced(daemon)).not.toHaveProperty("dashboard");
  expect(await dashReply(daemon)).toEqual([{ t: "dash", requestId: "r1", error: DASH_ERRORS.disabled }]);
});

test("with the env var set, the announcement carries dashboard and dash answers a snapshot", async () => {
  const daemon = new Daemon({ id: "t", name: "t" }, false, { PEW2_ORCA_DASHBOARD: "1" });
  expect(announced(daemon)?.dashboard).toEqual({ available: true });

  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, snapshot)));
  Object.assign(daemon, { dashboard: quiet(orca.path) });
  // Whatever else the phone puts on the frame never reaches the pipe.
  expect(await dashReply(daemon, { type: "tasks.complete", id: 1 })).toEqual([{ t: "dash", requestId: "r1", snapshot }]);
  expect(orca.lines.map((line) => JSON.parse(line).type)).toEqual(["phone.dash.snapshot"]);
});

const notesView = {
  view: "notes",
  generatedAt: 1_760_000_000_000,
  items: [{ id: 4, title: "Trip plan", detail: "★ 120 words", at: "2026-10-09T10:00:00Z" }],
} satisfies wire.DashView;

test("a page view writes only the enum name, and strips unknown keys from the reply", async () => {
  const orca = await fakeOrca((req, socket) =>
    send(socket, answer(req.requestId, { ...notesView, secret: "x", items: [{ ...notesView.items[0], content: "private body" }] })),
  );
  expect(await quiet(orca.path).view("notes")).toEqual({ ok: true, value: notesView });
  const written = JSON.parse(orca.lines[0] ?? "");
  expect(Object.keys(written).sort()).toEqual(["requestId", "type", "view"]);
  expect(written).toMatchObject({ type: "phone.view.get", view: "notes" });
});

test("a reply for a different page is refused", async () => {
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, { ...notesView, view: "projects" })));
  expect(await quiet(orca.path).view("notes")).toEqual({ ok: false, error: DASH_ERRORS.unreadable });
});

test("views are cached and coalesced per page, not across pages", async () => {
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, notesView)));
  const dash = quiet(orca.path);
  await Promise.all([dash.view("notes"), dash.view("notes")]);
  await dash.view("notes");
  expect(orca.lines).toHaveLength(1);
  await dash.view("projects");
  expect(orca.lines).toHaveLength(2);
});

test("with the dashboard on, a dash frame with a view answers items; an unlisted name is dropped by the schema", async () => {
  const daemon = new Daemon({ id: "t", name: "t" }, false, { PEW2_ORCA_DASHBOARD: "1" });
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, notesView)));
  Object.assign(daemon, { dashboard: quiet(orca.path) });
  const out: Record<string, unknown>[] = [];
  const run = (frame: unknown) =>
    handleMessage(JSON.stringify(frame), { daemon, reply: (m) => out.push(m as Record<string, unknown>), broadcast: () => {} });
  await run({ t: "dash", requestId: "r1", view: "notes" });
  expect(out).toEqual([{ t: "dash", requestId: "r1", view: "notes", items: notesView.items, generatedAt: notesView.generatedAt }]);
  out.length = 0;
  await run({ t: "dash", requestId: "r2", view: "settings" });
  expect(out[0]?.t).toBe("error");
  expect(orca.lines).toHaveLength(1);
});

test("with the env var unset, a view request says the dashboard is off", async () => {
  const daemon = new Daemon({ id: "t", name: "t" }, false, {});
  const out: Record<string, unknown>[] = [];
  await handleMessage(JSON.stringify({ t: "dash", requestId: "r1", view: "notes" }), {
    daemon,
    reply: (m) => out.push(m as Record<string, unknown>),
    broadcast: () => {},
  });
  expect(out).toEqual([{ t: "dash", requestId: "r1", error: DASH_ERRORS.disabled }]);
});

const taskReply = { task: { id: 7, title: "Buy milk", priority: "medium", status: "pending", secret: "stripped" } };

test("an add writes only the constant method, the title and the clientId", async () => {
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, taskReply)));
  const result = await quiet(orca.path).changeTask({ action: "add", title: "Buy milk", clientId: "c1" });
  expect(result).toEqual({ ok: true, value: { id: 7, title: "Buy milk", priority: "medium", status: "pending" } });
  const written = JSON.parse(orca.lines[0] ?? "");
  expect(Object.keys(written).sort()).toEqual(["clientId", "requestId", "title", "type"]);
  expect(written.type).toBe("phone.task.add");
});

test("a complete writes only the method and the id", async () => {
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, taskReply)));
  await quiet(orca.path).changeTask({ action: "complete", id: 7 });
  const written = JSON.parse(orca.lines[0] ?? "");
  expect(Object.keys(written).sort()).toEqual(["id", "requestId", "type"]);
  expect(written).toMatchObject({ type: "phone.task.complete", id: 7 });
});

test("writes are never cached or coalesced", async () => {
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, taskReply)));
  const dash = quiet(orca.path);
  await Promise.all([dash.changeTask({ action: "complete", id: 7 }), dash.changeTask({ action: "complete", id: 7 })]);
  await dash.changeTask({ action: "complete", id: 7 });
  expect(orca.lines).toHaveLength(3);
});

test("write refusals say what changed for a write, and a busy Orca is not retried", async () => {
  const off = await fakeOrca((req, socket) => send(socket, refusal(req.requestId, "TOOL_PERMISSION_DENIED")));
  expect(await quiet(off.path).changeTask({ action: "complete", id: 1 })).toEqual({ ok: false, error: DASH_ERRORS.writesOff });
  const gone = await fakeOrca((req, socket) => send(socket, refusal(req.requestId, "DATA_NOT_FOUND")));
  expect(await quiet(gone.path).changeTask({ action: "complete", id: 1 })).toEqual({ ok: false, error: DASH_ERRORS.taskMissing });
  const busy = await fakeOrca((req, socket) => send(socket, refusal(req.requestId, "DATA_VALIDATION", true)));
  expect(await quiet(busy.path).changeTask({ action: "add", title: "x", clientId: "c" })).toEqual({ ok: false, error: DASH_ERRORS.busy });
  expect(busy.lines).toHaveLength(1);
});

test("a write reply that is not a task is unreadable", async () => {
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, { task: { id: "x" } })));
  expect(await quiet(orca.path).changeTask({ action: "complete", id: 1 })).toEqual({ ok: false, error: DASH_ERRORS.unreadable });
});

test("a dash frame with a task reaches Orca; a bad one is dropped by the schema before the pipe", async () => {
  const daemon = new Daemon({ id: "t", name: "t" }, false, { PEW2_ORCA_DASHBOARD: "1" });
  const orca = await fakeOrca((req, socket) => send(socket, answer(req.requestId, taskReply)));
  Object.assign(daemon, { dashboard: quiet(orca.path) });
  const out: Record<string, unknown>[] = [];
  const run = (frame: unknown) =>
    handleMessage(JSON.stringify(frame), { daemon, reply: (m) => out.push(m as Record<string, unknown>), broadcast: () => {} });
  await run({ t: "dash", requestId: "r1", task: { action: "add", title: "  Buy milk ", clientId: "c1" } });
  expect(out).toEqual([{ t: "dash", requestId: "r1", task: { id: 7, title: "Buy milk", priority: "medium", status: "pending" } }]);
  expect(JSON.parse(orca.lines[0] ?? "").title).toBe("Buy milk");
  for (const task of [
    { action: "add", title: "", clientId: "c" },
    { action: "add", title: "x".repeat(201), clientId: "c" },
    { action: "complete", id: -1 },
    { action: "complete", id: 1.5 },
    { action: "delete", id: 1 },
  ]) {
    out.length = 0;
    await run({ t: "dash", requestId: "r2", task });
    expect(out[0]?.t).toBe("error");
  }
  expect(orca.lines).toHaveLength(1);
});

test("with the env var unset, a task request says the dashboard is off and nothing is written", async () => {
  const daemon = new Daemon({ id: "t", name: "t" }, false, {});
  const out: Record<string, unknown>[] = [];
  await handleMessage(JSON.stringify({ t: "dash", requestId: "r1", task: { action: "complete", id: 1 } }), {
    daemon,
    reply: (m) => out.push(m as Record<string, unknown>),
    broadcast: () => {},
  });
  expect(out).toEqual([{ t: "dash", requestId: "r1", error: DASH_ERRORS.disabled }]);
});
