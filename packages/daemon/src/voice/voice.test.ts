import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVoiceConfig, removeVoiceKey, voiceConfigPath, writeVoiceKey } from "./config.js";
import { createLiveSession, describeStatus } from "./openai.js";
import { VoiceManager } from "./manager.js";
import type { SessionView, VoiceHost, VoiceObservation } from "./host.js";
import type { SocketLike } from "./session.js";
import { speakable } from "./prompts.js";
import { addMonthSeconds, budgetSpentReason, readMonthSeconds, secondsLeft } from "./budget.js";
import { saveVoiceKey } from "../cli/voice.js";
import { handleMessage } from "../handler.js";
import { Daemon } from "../index.js";

const KEY = "sk-test_abcdefghijklmnopqrstuvwxyz0123";

function home(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PEW2_HOME: mkdtempSync(join(tmpdir(), "pew2-voice-")), ...extra } as NodeJS.ProcessEnv;
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  of(type: string) {
    return this.sent.filter((frame) => frame.type === type);
  }
}

function fakeHost(env: NodeJS.ProcessEnv) {
  const sessions = new Map<string, SessionView>();
  const dispatched: Record<string, unknown>[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  const answered: string[] = [];
  let n = 0;
  const host: VoiceHost = {
    env,
    agents: () => [
      { id: "claude-code", name: "Claude Code", available: true },
      { id: "codex", name: "Codex", available: true },
    ],
    projects: async () => [
      { name: "pew2", path: "/src/pew2" },
      { name: "website", path: "/src/website" },
    ],
    knownProject: async (_p, cwd) => (cwd.startsWith("/src/") ? cwd : undefined),
    lastWorkspace: async () => "/src/pew2",
    session: (id) => sessions.get(id),
    lastExchange: (id) => (sessions.has(id) ? { request: "fix tests", reply: "All **green**." } : undefined),
    dispatch: async (frame) => {
      dispatched.push(frame);
      const out: unknown[] = [];
      if (frame.t === "session.start") {
        const sessionId = `s${++n}`;
        sessions.set(sessionId, {
          sessionId,
          providerId: String(frame.providerId),
          cwd: String(frame.cwd),
          working: false,
          permissions: [],
        });
        out.push({ t: "session.started", sessionId, requestId: frame.requestId });
      }
      return { broadcasts: out, replies: [] };
    },
    answerPermission: (_s, requestId, optionId) => {
      answered.push(`${requestId}:${optionId}`);
      return true;
    },
    broadcast: (message) => broadcasts.push(message as Record<string, unknown>),
  };
  return { host, sessions, dispatched, broadcasts, answered };
}

async function started(extra: { fetchStatus?: number } = {}) {
  const env = home({ OPENAI_API_KEY: KEY });
  const fake = fakeHost(env);
  const requests: { url: string; init: RequestInit }[] = [];
  const sockets: FakeSocket[] = [];
  const manager = new VoiceManager(fake.host, {
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (extra.fetchStatus) return new Response("nope", { status: extra.fetchStatus });
      return Response.json(
        { session: { id: "live_1" }, transport: { type: "webrtc", sdp: "answer-sdp" } },
        { status: 201 },
      );
    },
    createSocket: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
  });
  const answer = await manager.start({ t: "voice.start", requestId: "r1", sdp: "offer-sdp" });
  return { ...fake, manager, requests, sockets, answer, socket: sockets[0] };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("env key wins over the file, the file is used otherwise", async () => {
  const env = home();
  expect((await readVoiceConfig(env)).apiKey).toBeUndefined();
  await mkdir(env.PEW2_HOME!, { recursive: true });
  await writeFile(voiceConfigPath(env), JSON.stringify({ openaiApiKey: "sk-file", voice: "cedar", maxMinutes: 10 }));
  expect(await readVoiceConfig(env)).toMatchObject({ apiKey: "sk-file", source: "file", voice: "cedar", maxMinutes: 10 });
  expect(await readVoiceConfig({ ...env, OPENAI_API_KEY: "sk-env" })).toMatchObject({ apiKey: "sk-env", source: "env" });
  expect(await removeVoiceKey(env)).toBe(true);
  expect((await readVoiceConfig(env)).apiKey).toBeUndefined();
  expect((await readVoiceConfig(env)).voice).toBe("cedar");
});

test("the key file is written owner-only and a wrong shape is refused", async () => {
  const env = home();
  expect((await saveVoiceKey("not-a-key", env)).ok).toBe(false);
  const saved = await saveVoiceKey(`  ${KEY}\n`, env);
  expect(saved.ok).toBe(true);
  expect(saved.message).not.toContain(KEY.slice(3));
  // Windows has no POSIX mode bits to set; there the file is protected by the
  // user profile it lives in.
  if (process.platform !== "win32") expect((await stat(voiceConfigPath(env))).mode & 0o777).toBe(0o600);
  expect((await readVoiceConfig(env)).apiKey).toBe(KEY);
  await writeVoiceKey(KEY, env);
});

test("session create sends the offer, config and headers, and answers with the SDP", async () => {
  const { requests, answer, socket } = await started();
  expect(answer).toEqual({
    t: "voice.answer",
    requestId: "r1",
    liveSessionId: "live_1",
    sdp: "answer-sdp",
    voiceRatePerMinuteUsd: 0.05,
  });
  const request = requests[0]!;
  expect(request.url).toBe("https://api.openai.com/v1/live/sessions");
  const headers = request.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  expect(headers["OpenAI-Safety-Identifier"]).toMatch(/^[0-9a-f]{64}$/);
  const body = JSON.parse(request.init.body as string) as {
    session: Record<string, unknown> & { delegation: { responses: Record<string, unknown> } };
    transport: unknown;
  };
  expect(body.transport).toEqual({ type: "webrtc", sdp: "offer-sdp" });
  expect(body.session.model).toBe("gpt-live-1");
  expect(body.session.audio).toEqual({ output: { voice: "vesper" } });
  expect(body.session.delegation.responses).toMatchObject({
    model: "gpt-6-luna",
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "low" },
  });
  expect(socket!.url).toBe("wss://api.openai.com/v1/live/sessions/live_1/attach");
  expect(socket!.headers.Authorization).toBe(`Bearer ${KEY}`);
});

test("create failures are sentences, and the key never appears in them", async () => {
  for (const status of [401, 403, 404, 429]) {
    const { answer } = await started({ fetchStatus: status });
    expect(answer.error).toBe(describeStatus(status));
    expect(answer.sdp).toBeUndefined();
  }
  const offline = await createLiveSession({
    apiKey: KEY,
    sdp: "x",
    session: {},
    fetch: async () => {
      throw new Error(`boom ${KEY}`);
    },
  });
  expect(offline).toEqual({ ok: false, error: "Your computer could not reach OpenAI. Check its internet connection." });
});

test("function calls are collected per response, run, answered, then continued", async () => {
  const { socket, dispatched, broadcasts } = await started();
  socket!.open();
  expect(broadcasts.at(-1)).toMatchObject({ t: "voice.status", state: "ready", liveSessionId: "live_1" });
  socket!.emit({
    type: "response.event",
    delegation_id: "d1",
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "send_to_agent",
        arguments: JSON.stringify({ message: "Fix the login test", agent: "claude", project: "web site" }),
      },
    },
  });
  socket!.emit({ type: "response.event", delegation_id: "d1", event: { type: "response.completed", response: { output: [] } } });
  await tick();
  const outputs = socket!.of("response.item.create");
  expect(outputs).toHaveLength(1);
  const item = outputs[0]!.item as { call_id: string; output: string };
  expect(item.call_id).toBe("call_1");
  expect(JSON.parse(item.output)).toMatchObject({ status: "started", agent: "Claude Code", project: "website" });
  expect(socket!.sent.at(-1)!.type).toBe("response.create");
  // Started a session in the matched project, then prompted it.
  expect(dispatched[0]).toMatchObject({ t: "session.start", providerId: "claude-code", cwd: "/src/website" });
  expect(dispatched[1]).toMatchObject({ t: "session.prompt", sessionId: "s1", text: "Fix the login test" });
});

test("a function call still runs, once, when no completion event arrives", async () => {
  const { LiveVoiceSession } = await import("./session.js");
  const saved = LiveVoiceSession.PENDING_FALLBACK_MS;
  LiveVoiceSession.PENDING_FALLBACK_MS = 5;
  try {
    const { socket } = await started();
    socket!.open();
    socket!.emit({
      type: "response.event",
      delegation_id: "d2",
      event: {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_2", name: "coding_status", arguments: "{}" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket!.of("response.item.create")).toHaveLength(1);
    expect(socket!.of("response.create")).toHaveLength(1);
    // A completion arriving late must not answer the same call twice.
    socket!.emit({ type: "response.event", delegation_id: "d2", event: { type: "response.completed", response: { output: [] } } });
    await tick();
    expect(socket!.of("response.item.create")).toHaveLength(1);
  } finally {
    LiveVoiceSession.PENDING_FALLBACK_MS = saved;
  }
});

test("a finished turn and an approval are spoken as commentary", async () => {
  const { manager, socket, broadcasts, sessions, answered } = await started();
  socket!.open();
  const session = manager.sessions()[0]!;
  await session.runTool("send_to_agent", { message: "Run the tests" });
  await tick();
  const observe = (o: VoiceObservation) => manager.observe(o);
  observe({ sessionId: "s1", kind: "turn_start" });
  expect(broadcasts.at(-1)).toMatchObject({ state: "agent_working", sessionId: "s1", folder: "pew2" });

  const params = {
    toolCall: { title: "Run `npm test`" },
    options: [
      { optionId: "allow", name: "Allow once" },
      { optionId: "reject", name: "Reject" },
    ],
  };
  observe({ sessionId: "s1", kind: "update", payload: { kind: "permission_request", requestId: "p1", params } });
  expect(broadcasts.at(-1)).toMatchObject({ state: "agent_waiting", detail: "Run npm test" });
  const ask = socket!.of("session.commentary.append").at(-1)!;
  expect(ask.delegation_id).toBeNull();
  expect(String(ask.content)).toContain("Allow once, Reject");

  sessions.get("s1")!.permissions = [{ requestId: "p1", params }];
  expect(await session.runTool("answer_approval", { option: "allow" })).toMatchObject({ status: "answered" });
  expect(answered).toEqual(["p1:allow"]);

  observe({
    sessionId: "s1",
    kind: "update",
    payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All **14** tests pass.\n```\nok\n```" } } },
  });
  observe({ sessionId: "s1", kind: "turn_end" });
  expect(broadcasts.at(-1)).toMatchObject({ state: "agent_done", sessionId: "s1" });
  const done = String(socket!.of("session.commentary.append").at(-1)!.content);
  expect(done).toContain("Claude Code has finished in pew2");
  expect(done).toContain("All 14 tests pass.");
  expect(done).not.toContain("```");
  expect(await session.runTool("read_agent_reply", {})).toMatchObject({ reply: expect.stringContaining("All **14**") });
});

test("hang_up schedules a close so the goodbye is heard first", async () => {
  const { LiveVoiceSession } = await import("./session.js");
  const saved = LiveVoiceSession.HANGUP_DELAY_MS;
  LiveVoiceSession.HANGUP_DELAY_MS = 10;
  try {
    const { manager, socket } = await started();
    socket!.open();
    const session = manager.sessions()[0]!;
    const result = (await session.runTool("hang_up", {})) as { status: string };
    expect(result.status).toBe("closing");
    expect(socket!.of("session.close")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(socket!.of("session.close")).toHaveLength(1);
    // Confirming the close tears the session down.
    socket!.emit({ type: "session.closed" });
    await tick();
    expect(session.done).toBe(true);
  } finally {
    LiveVoiceSession.HANGUP_DELAY_MS = saved;
  }
});

test("voice.stop sends session.close and cleans up on session.closed", async () => {
  const { manager, socket, broadcasts } = await started();
  socket!.open();
  const stopping = manager.stop("live_1");
  expect(socket!.of("session.close")).toHaveLength(1);
  socket!.emit({ type: "session.usage.updated", usage: { seconds: 42 } });
  socket!.emit({ type: "session.closed" });
  await stopping;
  expect(manager.sessions()).toHaveLength(0);
  expect(socket!.closed).toBe(true);
  expect(broadcasts.at(-1)).toMatchObject({ state: "closed", liveSessionId: "live_1" });
});

test("the maximum duration closes the session", async () => {
  const env = home({ OPENAI_API_KEY: KEY });
  await mkdir(env.PEW2_HOME!, { recursive: true });
  await writeFile(voiceConfigPath(env), JSON.stringify({ maxMinutes: 0.001 }));
  const { host } = fakeHost(env);
  let socket: FakeSocket | undefined;
  const manager = new VoiceManager(host, {
    fetch: async () => Response.json({ session: { id: "live_t" }, transport: { sdp: "a" } }, { status: 201 }),
    createSocket: (url, headers) => (socket = new FakeSocket(url, headers)),
  });
  await manager.start({ t: "voice.start", requestId: "r", sdp: "o" });
  socket!.open();
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(socket!.of("session.close")).toHaveLength(1);
  socket!.emit({ type: "session.closed" });
  expect(manager.sessions()).toHaveLength(0);
});

test("speakable strips markdown and code", () => {
  expect(speakable("## Done\n- fixed `foo.ts`\n```ts\nx\n```\n**ok**")).toBe("Done fixed foo.ts (code omitted) ok");
});

test("voice.start with no key answers with how to add one, and the announcement says so", async () => {
  const env = home({ OPENAI_API_KEY: "" });
  const daemon = new Daemon({ id: "t", name: "t" }, false, env);
  const sent: Record<string, unknown>[] = [];
  daemon.attach((message) => sent.push(message as Record<string, unknown>));
  const replies: Record<string, unknown>[] = [];
  await handleMessage(JSON.stringify({ t: "voice.start", requestId: "r9", sdp: "offer" }), {
    daemon,
    reply: (m) => replies.push(m as Record<string, unknown>),
    broadcast: () => {},
  });
  expect(replies[0]).toMatchObject({ t: "voice.answer", requestId: "r9" });
  expect(String(replies[0]!.error)).toContain("pew2 voice key");

  await daemon.refreshProviders();
  expect(sent.findLast((m) => m.t === "providers")!.voice).toEqual({
    available: false,
    reason: "Add an OpenAI API key on your computer: run pew2 voice key",
  });
  await writeVoiceKey(KEY, env);
  await daemon.refreshProviders();
  expect(sent.findLast((m) => m.t === "providers")!.voice).toEqual({ available: true });
  daemon.closeAll();
});

// ------------------------------------------------------------- monthly cap

test("the cap is turned into seconds at the rate, and a new month starts from nothing", async () => {
  expect(secondsLeft(10, 0.05, 0)).toBe(12_000);
  expect(secondsLeft(10, 0.05, 12_500)).toBe(0);
  const env = home();
  await addMonthSeconds(300, env, new Date(2026, 9, 31));
  expect(await readMonthSeconds(env, new Date(2026, 9, 31))).toBe(300);
  expect(await readMonthSeconds(env, new Date(2026, 10, 1))).toBe(0);
  expect(budgetSpentReason(10, new Date(2026, 9, 14))).toBe(
    "This month's $10.00 voice budget is used up. It resets on 1 November.",
  );
});

test("a spent month refuses the call before OpenAI is asked, and the announcement says why", async () => {
  const env = home({ OPENAI_API_KEY: KEY });
  await addMonthSeconds(12_000, env);
  let asked = false;
  const manager = new VoiceManager(fakeHost(env).host, {
    fetch: async () => {
      asked = true;
      return new Response("unreachable", { status: 500 });
    },
  });
  const answer = await manager.start({ t: "voice.start", requestId: "r", sdp: "o" });
  expect(asked).toBe(false);
  expect(answer.error).toContain("voice budget is used up");
  expect((await manager.refresh()).reason).toContain("voice budget is used up");
});

test("a finished call's minutes are added to the month", async () => {
  const { manager, socket, host } = await started();
  socket!.open();
  socket!.emit({ type: "session.usage.updated", usage: { seconds: 42 } });
  socket!.emit({ type: "session.closed" });
  await manager.refresh();
  expect(Math.round(await readMonthSeconds(host.env))).toBe(42);
});

test("a call ends when the month's budget runs out, even inside the per-call limit", async () => {
  const env = home({ OPENAI_API_KEY: KEY });
  // One second left of $10 at $0.05 a minute.
  await addMonthSeconds(11_999, env);
  let socket: FakeSocket | undefined;
  const manager = new VoiceManager(fakeHost(env).host, {
    fetch: async () => Response.json({ session: { id: "live_b" }, transport: { sdp: "a" } }, { status: 201 }),
    createSocket: (url, headers) => (socket = new FakeSocket(url, headers)),
  });
  await manager.start({ t: "voice.start", requestId: "r", sdp: "o" });
  socket!.open();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(socket!.of("session.close")).toHaveLength(1);
});
