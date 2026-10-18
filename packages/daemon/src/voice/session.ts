/**
 * One live voice conversation, seen from the sideband.
 *
 * The phone holds the audio; this holds the tools. It reads the backend's
 * function calls off the sideband, runs them against the daemon, returns the
 * results, and tells the voice model what the coding agent did when that
 * happens — minutes later, long after the tool call returned.
 */
import { basename } from "node:path";
import type { VoiceHost, VoiceObservation } from "./host.js";
import { clampAppend, speakable, tail } from "./prompts.js";

/** The subset of a WebSocket this needs, so tests can hand in a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type CreateSocket = (url: string, headers: Record<string, string>) => SocketLike;

export const defaultCreateSocket: CreateSocket = (url, headers) =>
  // Bun's WebSocket takes headers as a second-argument option; the DOM type
  // does not know that.
  new WebSocket(url, { headers } as unknown as string[]) as unknown as SocketLike;

export interface Target {
  sessionId?: string;
  providerId?: string;
  cwd?: string;
  agentSessionId?: string;
}

interface Watched {
  providerId: string;
  folder: string;
  /** The current turn's reply, end kept. */
  reply: string;
  lastReply?: string;
  voiceTurn: boolean;
}

interface FunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}

const REPLY_BUFFER = 8000;
const READ_REPLY_MAX = 6000;
const CLOSE_WAIT_MS = 5000;

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function chunkText(payload: unknown): string | undefined {
  const update = (payload as { update?: { sessionUpdate?: unknown; content?: unknown } } | null)
    ?.update;
  if (update?.sessionUpdate !== "agent_message_chunk") return undefined;
  const content = update.content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: unknown; text?: unknown }) =>
        b?.type === "text" && typeof b.text === "string" ? b.text : "",
      )
      .join("");
  }
  const single = (content as { text?: unknown } | null)?.text;
  return typeof single === "string" ? single : undefined;
}

/** What an approval asks, in words, with its options. */
export function describePermission(params: unknown): {
  title: string;
  options: { optionId: string; name: string }[];
} {
  const p = params as {
    toolCall?: { title?: unknown; kind?: unknown };
    options?: { optionId?: unknown; name?: unknown }[];
  } | null;
  const title =
    typeof p?.toolCall?.title === "string"
      ? speakable(p.toolCall.title)
      : typeof p?.toolCall?.kind === "string"
        ? `run a ${p.toolCall.kind} action`
        : "do something";
  const options = (Array.isArray(p?.options) ? p.options : []).flatMap((o) =>
    typeof o?.optionId === "string"
      ? [{ optionId: o.optionId, name: typeof o.name === "string" ? o.name : o.optionId }]
      : [],
  );
  return { title, options };
}

export class LiveVoiceSession {
  private socket?: SocketLike;
  private outbox: string[] = [];
  private readonly watched = new Map<string, Watched>();
  /** Function calls collected per delegation, run when its response completes. */
  private readonly pending = new Map<string, FunctionCall[]>();
  /**
   * Fallback per delegation: run collected calls if the backend's completion
   * event never arrives. The docs say lifecycle events are forwarded, but a
   * tool loop that waits on one event the service might not send leaves the
   * assistant promising work that never starts, which is the worst failure a
   * voice user can meet: silence. With `parallel_tool_calls: false` a
   * finished function item is already the whole set.
   */
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  static PENDING_FALLBACK_MS = 1500;
  /**
   * Delay between the hang_up tool and the actual close, so the goodbye the
   * backend returns is spoken before the line goes dead. Without it the call
   * ends mid-sentence, which reads as being cut off, not hung up.
   */
  static HANGUP_DELAY_MS = 4000;
  /**
   * The longest `coding_status` waits for any one agent's project list. Orca says
   * nothing while a tool runs, so a slow or broken agent (one that has to start up,
   * or fails to) must not hold the whole call in silence: it is listed with no
   * projects instead, and the call carries on. 12 s of silence got calls hung up.
   */
  static STATUS_AGENT_MS = 1500;
  /** Longest spoken line written to the log. */
  static LINE_LOG_MAX = 400;
  /** A line of Orca's that ends the call: it finishes on a goodbye or "hanging up". */
  static GOODBYE = /(?:hanging up(?: now)?|good-?bye|bye(?: for now| then)?)[.!]*$/i;
  /** The pending close is Orca's goodbye, not the `hang_up` tool: more words cancel it. */
  private goodbyeArmed = false;
  private hangupTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  /** Settles `closing` the moment the session finishes, by whatever route. */
  private settleClosing?: () => void;
  private closeFallback?: ReturnType<typeof setTimeout>;
  private finished = false;
  private sequence = 0;
  /** How many of each kind of message OpenAI sent this call. */
  private readonly seenKinds = new Map<string, number>();
  /**
   * The line being said right now, written to the log when the other side
   * speaks, a tool runs, or the call ends. A call that "did nothing" was
   * undiagnosable from kinds and counts alone: whether Orca misheard, asked
   * a question, or promised work she never sent only shows in the words.
   * Local log only; never sent anywhere.
   */
  private line?: { speaker: "you" | "orca"; text: string };
  /** What ended the call, when this side ended it; otherwise OpenAI or the connection did. */
  private endedBy?: string;
  /**
   * What Orca says first, unprompted, once the call connects: set when the
   * call is the user answering a ring, who otherwise hears silence and has to
   * ask what she is calling about.
   */
  private opening?: string;
  usageSeconds = 0;

  constructor(
    readonly liveSessionId: string,
    private readonly host: VoiceHost,
    public target: Target,
    private readonly options: {
      maxMs: number;
      onFinished: (session: LiveVoiceSession) => void;
    },
  ) {}

  /** Attach the sideband and start the clock. */
  attach(createSocket: CreateSocket, url: string, headers: Record<string, string>) {
    let socket: SocketLike;
    try {
      socket = createSocket(url, headers);
    } catch {
      this.status("error", { detail: "Could not connect to the voice session's control channel." });
      this.finish();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      for (const frame of this.outbox.splice(0)) socket.send(frame);
      this.status("ready");
    };
    socket.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      void this.onEvent(parsed as Record<string, unknown>);
    };
    socket.onerror = () => {};
    socket.onclose = () => this.finish();
    this.timer = setTimeout(() => void this.close("the call time limit"), this.options.maxMs);
    this.timer.unref?.();
  }

  private eventId(prefix: string) {
    return `pew2_${prefix}_${++this.sequence}`;
  }

  private sendFrame(frame: Record<string, unknown>) {
    const text = JSON.stringify(frame);
    if (this.socket && this.socket.readyState === 1) this.socket.send(text);
    else if (!this.finished) this.outbox.push(text);
  }

  /** Have Orca open the call with this, as soon as it connects. */
  openWith(content: string) {
    this.opening = content;
  }

  commentary(content: string) {
    this.sendFrame({
      type: "session.commentary.append",
      event_id: this.eventId("commentary"),
      delegation_id: null,
      content: clampAppend(content),
    });
  }

  private status(
    state: "ready" | "agent_working" | "agent_waiting" | "agent_done" | "closed" | "error",
    extra: { sessionId?: string; providerId?: string; folder?: string; detail?: string } = {},
  ) {
    this.host.broadcast({ t: "voice.status", liveSessionId: this.liveSessionId, state, ...extra });
  }

  private agentName(providerId: string) {
    return this.host.agents().find((a) => a.id === providerId)?.name ?? providerId;
  }

  private async onEvent(event: Record<string, unknown>) {
    this.noteKind(event);
    switch (event.type) {
      case "response.event": {
        const inner = event.event as
          | { type?: unknown; item?: { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown } }
          | undefined;
        const key = typeof event.delegation_id === "string" ? event.delegation_id : "";
        if (inner?.type === "response.output_item.done" && inner.item?.type === "function_call") {
          const { call_id, name } = inner.item;
          if (typeof call_id !== "string" || typeof name !== "string") return;
          this.flushLine();
          console.log(`[voice] ${this.liveSessionId} tool call received: ${name}`);
          const args = typeof inner.item.arguments === "string" ? inner.item.arguments : "{}";
          const list = this.pending.get(key) ?? [];
          list.push({ call_id, name, arguments: args });
          this.pending.set(key, list);
          clearTimeout(this.pendingTimers.get(key));
          const timer = setTimeout(() => void this.runPending(key), LiveVoiceSession.PENDING_FALLBACK_MS);
          timer.unref?.();
          this.pendingTimers.set(key, timer);
        } else if (inner?.type === "response.completed" || inner?.type === "response.done") {
          // `output` is always empty here; the calls were read item by item.
          await this.runPending(key);
        }
        return;
      }
      case "session.usage.updated": {
        const seconds = (event.usage as { seconds?: unknown } | undefined)?.seconds;
        if (typeof seconds === "number") {
          this.usageSeconds = seconds;
          console.log(`[voice] ${this.liveSessionId}: ${seconds}s of voice used`);
        }
        return;
      }
      case "error": {
        const error = event.error as { code?: unknown; message?: unknown } | undefined;
        const code = typeof error?.code === "string" ? error.code : "";
        const said = typeof error?.message === "string" ? error.message : "";
        console.error(`[voice] ${this.liveSessionId} error: ${code} ${said}`);
        return;
      }
      case "session.started":
        // Said as the call connects, not queued before it: Orca speaks on a
        // commentary, and words sent ahead of the line opening are lost.
        if (this.opening) {
          const opening = this.opening;
          this.opening = undefined;
          this.commentary(opening);
        }
        return;
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
        if (typeof event.delta === "string") {
          this.hear(event.type === "session.input_transcript.delta" ? "you" : "orca", event.delta);
        }
        return;
      case "session.closed":
        console.log(`[voice] ${this.liveSessionId} closed after ${this.usageSeconds}s`);
        this.finish();
        return;
      default:
        return;
    }
  }

  private async runPending(key: string) {
    clearTimeout(this.pendingTimers.get(key));
    this.pendingTimers.delete(key);
    const calls = this.pending.get(key);
    if (!calls || calls.length === 0) return;
    this.pending.delete(key);
    for (const call of calls) {
      let output: unknown;
      const started = Date.now();
      let given = "";
      try {
        const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        given = Object.keys(args).join(",");
        output = await this.runTool(call.name, args);
      } catch (error) {
        output = { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
      // What Orca did, never what was said: so a call that "did nothing" can be told apart from one
      // that sent to the wrong place or failed.
      console.log(
        `[voice] ${this.liveSessionId} tool ${call.name}(${given}): ${toolOutcome(output)} (${Date.now() - started}ms)`,
      );
      this.sendFrame({
        type: "response.item.create",
        event_id: this.eventId("tool"),
        item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) },
      });
    }
    this.sendFrame({ type: "response.create", event_id: this.eventId("continue") });
  }

  // ---------------------------------------------------------------- tools

  async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "coding_status":
        return this.toolStatus();
      case "send_to_agent":
        return this.toolSend(args);
      case "read_agent_reply":
        return this.toolRead();
      case "answer_approval":
        return this.toolAnswer(typeof args.option === "string" ? args.option : "");
      case "hang_up":
        // Asked for outright: a close her goodbye already scheduled now stands
        // whatever she says next.
        this.goodbyeArmed = false;
        this.hangupTimer ??= setTimeout(() => void this.close("Orca (hang_up)"), LiveVoiceSession.HANGUP_DELAY_MS);
        this.hangupTimer.unref?.();
        return { status: "closing", note: "The call will end in a few seconds. Say a short goodbye now." };
      case "stop_agent":
        return this.toolStop();
      default:
        return { status: "error", error: `No tool called ${name}.` };
    }
  }

  private async toolStatus() {
    const agents = this.host.agents();
    const recent = await Promise.all(
      agents
        .filter((a) => a.available)
        .map(async (a) => ({
          agent: a.name,
          projects: (await this.projectsWithin(a.id, LiveVoiceSession.STATUS_AGENT_MS))
            .slice(0, 6)
            .map((p) => p.name),
        })),
    );
    const view = this.target.sessionId ? this.host.session(this.target.sessionId) : undefined;
    const providerId = view?.providerId ?? this.target.providerId;
    const cwd = view?.cwd ?? this.target.cwd;
    const approval = view?.permissions[0];
    return {
      agents: agents.map((a) => ({ id: a.id, name: a.name, available: a.available })),
      current: providerId
        ? {
            agent: this.agentName(providerId),
            project: cwd ? basename(cwd) : undefined,
            open: view !== undefined,
            working: view?.working ?? false,
            waiting_for_approval: approval
              ? (() => {
                  const d = describePermission(approval.params);
                  return { wants_to: d.title, options: d.options.map((o) => o.name) };
                })()
              : undefined,
          }
        : "none",
      recent_projects: recent,
    };
  }

  /** An agent's projects, or none if it has not answered within `ms` or fails. */
  private async projectsWithin(providerId: string, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ name: string; path: string }[]>((resolve) => {
      // Cancelled below, so it is not left to keep the process alive or to fire late.
      timer = setTimeout(() => resolve([]), ms);
    });
    try {
      return await Promise.race([this.host.projects(providerId).catch(() => []), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private matchAgent(query: string) {
    const q = norm(query);
    const agents = this.host.agents().filter((a) => a.available);
    return (
      agents.find((a) => norm(a.id) === q || norm(a.name) === q) ??
      agents.find((a) => norm(a.name).includes(q) || norm(a.id).includes(q) || q.includes(norm(a.id)))
    );
  }

  private async toolSend(args: Record<string, unknown>) {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!message) return { status: "error", error: "No message to send." };
    const current = this.target.sessionId ? this.host.session(this.target.sessionId) : undefined;

    let providerId = current?.providerId ?? this.target.providerId;
    let agentChanged = false;
    if (typeof args.agent === "string" && args.agent.trim()) {
      const agent = this.matchAgent(args.agent);
      if (!agent) {
        return {
          status: "error",
          error: `No agent matching "${args.agent}". Available: ${this.host
            .agents()
            .filter((a) => a.available)
            .map((a) => a.name)
            .join(", ")}.`,
        };
      }
      agentChanged = agent.id !== providerId;
      providerId = agent.id;
    }
    providerId ??= this.host.agents().find((a) => a.available)?.id;
    if (!providerId) return { status: "error", error: "No coding agent is available on the computer." };

    let cwd = agentChanged ? undefined : (current?.cwd ?? this.target.cwd);
    let projectChanged = false;
    if (typeof args.project === "string" && args.project.trim()) {
      const q = norm(args.project);
      const projects = await this.host.projects(providerId).catch(() => []);
      const hit =
        projects.find((p) => norm(p.name) === q) ?? projects.find((p) => norm(p.name).includes(q));
      const known = hit ? await this.host.knownProject(providerId, hit.path) : undefined;
      if (!known) {
        return {
          status: "error",
          error: `No project matching "${args.project}" for ${this.agentName(providerId)}. Recent: ${projects
            .slice(0, 6)
            .map((p) => p.name)
            .join(", ")}.`,
        };
      }
      projectChanged = known !== cwd;
      cwd = known;
    }
    cwd ??= await this.host.lastWorkspace(providerId);

    const fresh = args.new_conversation === true;
    const continuing = !fresh && !agentChanged && !projectChanged && this.target.sessionId !== undefined;
    // Another project (or no conversation yet): that project's latest chat, not
    // a new one beside it. A new chat every time scattered voice work across
    // half a dozen stubs the desktop was not showing (2026-10-18: five in an
    // hour), so the chat open there never saw any of it.
    const latest =
      !continuing && !fresh && cwd
        ? await this.host.latestConversation(providerId, cwd).catch(() => undefined)
        : undefined;
    const agent = this.agentName(providerId);
    const project = cwd ? basename(cwd) : undefined;

    // Not awaited: opening an agent takes seconds and its turn minutes. The
    // voice model is told the outcome by commentary when there is one.
    void this.deliver(message, providerId, cwd, continuing, latest?.agentSessionId).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.status("error", { providerId, folder: project, detail: reason });
      this.commentary(`The message to ${agent} could not be sent: ${reason}`);
    });
    return {
      status: "started",
      agent,
      project,
      conversation: continuing
        ? "continuing the current conversation"
        : latest
          ? `continuing the latest conversation in ${project ?? "that project"}${latest.title ? ` ("${latest.title}")` : ""}`
          : "new conversation",
      note: "The agent is working in the background. You will be told when it finishes or needs approval.",
    };
  }

  /**
   * @param latest The project's latest stored conversation, to continue when
   *   not continuing the current one: reused if it is already open here (one
   *   conversation must not be opened twice), reopened otherwise.
   */
  private async deliver(
    message: string,
    providerId: string,
    cwd: string | undefined,
    continuing: boolean,
    latest?: string,
  ) {
    let sessionId: string | undefined;
    if (continuing && this.target.sessionId && this.host.session(this.target.sessionId)) {
      sessionId = this.target.sessionId;
    } else if (continuing && this.target.agentSessionId) {
      // The conversation's agent was reaped or the daemon restarted: reopen it
      // rather than silently starting a fresh one.
      sessionId = await this.reopen(providerId, this.target.agentSessionId, cwd);
    } else if (latest) {
      sessionId = this.host.openConversation(providerId, latest) ?? (await this.reopen(providerId, latest, cwd));
    }
    if (!sessionId) {
      const requestId = `voice:${this.liveSessionId}:${++this.sequence}`;
      const { broadcasts, replies } = await this.host.dispatch({
        t: "session.start",
        requestId,
        providerId,
        ...(cwd && { cwd }),
      });
      sessionId = startedId(broadcasts, (m) => m.requestId === requestId);
      if (!sessionId) throw new Error(replyError(replies) ?? "the agent could not be started");
    }
    const view = this.host.session(sessionId);
    this.target = {
      sessionId,
      providerId,
      cwd: view?.cwd ?? cwd,
      agentSessionId: view?.agentSessionId,
    };
    this.watched.set(sessionId, {
      providerId,
      folder: basename(view?.cwd ?? cwd ?? ""),
      reply: "",
      voiceTurn: true,
      lastReply: this.watched.get(sessionId)?.lastReply,
    });
    const id = sessionId;
    // `origin: "voice"`: these are Orca's words for the user, and the chat says so.
    await this.host.dispatch({ t: "session.prompt", sessionId: id, text: message, origin: "voice" }, (reply) => {
      const error = replyError([reply]);
      if (error) this.commentary(`${this.agentName(providerId)} could not take that message: ${error}`);
    });
  }

  /** Open a stored conversation through the shared handler; its live session id. */
  private async reopen(providerId: string, agentSessionId: string, cwd: string | undefined) {
    const { broadcasts, replies } = await this.host.dispatch({
      t: "session.resume",
      providerId,
      agentSessionId,
      ...(cwd && { cwd }),
    });
    const sessionId = startedId(broadcasts, (m) => m.agentSessionId === agentSessionId);
    if (!sessionId) throw new Error(replyError(replies) ?? "the conversation could not be reopened");
    return sessionId;
  }

  private toolRead() {
    const sessionId = this.target.sessionId;
    if (!sessionId) return { status: "none", note: "There is no current conversation." };
    const watched = this.watched.get(sessionId);
    const exchange = this.host.lastExchange(sessionId);
    const reply = (watched?.voiceTurn ? watched.reply : watched?.lastReply) || exchange?.reply || "";
    const view = this.host.session(sessionId);
    return {
      agent: view ? this.agentName(view.providerId) : undefined,
      working: view?.working ?? false,
      request: exchange?.request ? tail(exchange.request, 1000) : undefined,
      reply: reply ? tail(reply, READ_REPLY_MAX) : "No reply yet.",
    };
  }

  private toolAnswer(option: string) {
    const sessionId = this.target.sessionId;
    const view = sessionId ? this.host.session(sessionId) : undefined;
    const pending = view?.permissions[0];
    if (!view || !pending) return { status: "none", note: "Nothing is waiting for approval." };
    const { options } = describePermission(pending.params);
    const q = norm(option);
    const chosen =
      options.find((o) => norm(o.optionId) === q || norm(o.name) === q) ??
      options.find((o) => norm(o.name).includes(q) || norm(o.optionId).includes(q));
    if (!chosen) {
      return { status: "error", error: `No option "${option}". Options: ${options.map((o) => o.name).join(", ")}.` };
    }
    if (!this.host.answerPermission(view.sessionId, pending.requestId, chosen.optionId)) {
      return { status: "error", error: "That approval was already answered or has gone." };
    }
    this.status("agent_working", this.statusFor(view.sessionId));
    return { status: "answered", option: chosen.name };
  }

  private async toolStop() {
    const sessionId = this.target.sessionId;
    const view = sessionId ? this.host.session(sessionId) : undefined;
    if (!view?.working) return { status: "none", note: "The agent is not working on anything." };
    const { replies } = await this.host.dispatch({ t: "session.cancel", sessionId: view.sessionId });
    const error = replyError(replies);
    return error ? { status: "error", error } : { status: "stopping" };
  }

  // ---------------------------------------------------------- observation

  private statusFor(sessionId: string) {
    const w = this.watched.get(sessionId);
    return { sessionId, providerId: w?.providerId, folder: w?.folder || undefined };
  }

  observe(observation: VoiceObservation) {
    const watched = this.watched.get(observation.sessionId);
    if (!watched || this.finished) return;
    const agent = this.agentName(watched.providerId);
    const where = watched.folder ? ` in ${watched.folder}` : "";
    if (observation.kind === "turn_start") {
      if (!watched.voiceTurn) return;
      watched.reply = "";
      this.status("agent_working", this.statusFor(observation.sessionId));
      return;
    }
    if (observation.kind === "turn_end") {
      if (!watched.voiceTurn) return;
      watched.voiceTurn = false;
      watched.lastReply = watched.reply;
      this.status("agent_done", this.statusFor(observation.sessionId));
      const said = speakable(watched.reply);
      this.commentary(
        said
          ? `${agent} has finished${where}. Its reply ends: ${tail(said, 1200)}`
          : `${agent} has finished${where} without a written reply.`,
      );
      return;
    }
    const text = chunkText(observation.payload);
    if (text !== undefined) {
      if (watched.voiceTurn) watched.reply = `${watched.reply}${text}`.slice(-REPLY_BUFFER);
      return;
    }
    const payload = observation.payload as { kind?: unknown; params?: unknown } | null;
    if (payload?.kind === "permission_request") {
      const { title, options } = describePermission(payload.params);
      this.status("agent_waiting", { ...this.statusFor(observation.sessionId), detail: title });
      this.commentary(
        `${agent}${where} is waiting for approval to ${title}. Options: ${options.map((o) => o.name).join(", ") || "none given"}. Ask the user which they want.`,
      );
    }
  }

  // ------------------------------------------------------------- closing

  /**
   * Ask OpenAI to end the session, and wait briefly for it to confirm.
   *
   * @param by What is ending it, for the log line: a call that ends without
   *   the work being sent reads very differently if the user hung up.
   */
  close(by = "pew2"): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.endedBy ??= by;
    this.closing ??= new Promise<void>((resolve) => {
      if (!this.socket || this.socket.readyState !== 1) {
        this.finish();
        resolve();
        return;
      }
      // Settled by `finish`, which OpenAI's `session.closed` reaches as soon as
      // it confirms — not by polling for it. A poll on an unref'd timer never
      // fired under Bun on Windows with nothing else keeping the loop alive, so
      // a stop could wait forever.
      this.settleClosing = resolve;
      this.sendFrame({ type: "session.close" });
      this.closeFallback = setTimeout(() => this.finish(), CLOSE_WAIT_MS);
      this.closeFallback.unref?.();
    });
    return this.closing;
  }

  get done() {
    return this.finished;
  }

  /** Count a message by kind (`response.event` by what it carries), for the summary logged at the end. */
  private noteKind(event: Record<string, unknown>) {
    const kind = typeof event.type === "string" ? event.type : "unknown";
    const inner =
      kind === "response.event" ? (event.event as { type?: unknown } | undefined)?.type : undefined;
    const label = typeof inner === "string" ? `${kind}>${inner}` : kind;
    this.seenKinds.set(label, (this.seenKinds.get(label) ?? 0) + 1);
  }

  /** A fragment of what was said; a change of speaker writes the last line out. */
  private hear(speaker: "you" | "orca", delta: string) {
    if (this.line && this.line.speaker !== speaker) this.flushLine();
    this.line ??= { speaker, text: "" };
    this.line.text += delta;
    if (speaker === "orca") this.watchForGoodbye(this.line.text);
  }

  /**
   * End the call when Orca says goodbye, whether or not she asked for it.
   *
   * Ending a call is a tool her backend has to call, and she does not always:
   * on 2026-10-18 15:12Z she said "Okay, hanging up now. Goodbye." twice and the
   * line stayed open until the user pressed the button. Her own goodbye is the
   * plainest sign the call is over, so it closes the call after the same pause
   * `hang_up` uses. Anything more she says stands it down.
   */
  private watchForGoodbye(line: string) {
    const saidGoodbye = LiveVoiceSession.GOODBYE.test(line.trim());
    if (saidGoodbye && !this.hangupTimer) {
      this.goodbyeArmed = true;
      console.log(`[voice] ${this.liveSessionId} Orca said goodbye; ending the call in ${LiveVoiceSession.HANGUP_DELAY_MS / 1000}s`);
      this.hangupTimer = setTimeout(() => void this.close("Orca saying goodbye"), LiveVoiceSession.HANGUP_DELAY_MS);
      this.hangupTimer.unref?.();
    } else if (!saidGoodbye && this.goodbyeArmed) {
      // She carried on past it ("Goodbye — oh, one more thing"): not over yet.
      this.goodbyeArmed = false;
      clearTimeout(this.hangupTimer);
      this.hangupTimer = undefined;
    }
  }

  private flushLine() {
    const line = this.line;
    this.line = undefined;
    const text = line?.text.replace(/\s+/g, " ").trim();
    if (!line || !text) return;
    const clipped = text.length > LiveVoiceSession.LINE_LOG_MAX ? `${text.slice(0, LiveVoiceSession.LINE_LOG_MAX)}…` : text;
    console.log(`[voice] ${this.liveSessionId} ${line.speaker}: "${clipped}"`);
  }

  /** Tear down once, whatever ended it. */
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.flushLine();
    console.log(`[voice] ${this.liveSessionId} ended by ${this.endedBy ?? "OpenAI or the connection"}`);
    const kinds = [...this.seenKinds].map(([kind, count]) => `${kind}x${count}`).join(" ") || "none";
    console.log(`[voice] ${this.liveSessionId} messages from OpenAI: ${kinds}`);
    if (this.timer) clearTimeout(this.timer);
    if (this.closeFallback) clearTimeout(this.closeFallback);
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    this.outbox = [];
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close(1000, "done");
      } catch {
        // Already gone.
      }
    }
    this.status("closed");
    this.options.onFinished(this);
    this.settleClosing?.();
  }
}

function startedId(
  broadcasts: unknown[],
  match: (message: Record<string, unknown>) => boolean,
): string | undefined {
  for (const message of broadcasts) {
    const m = message as Record<string, unknown>;
    if (m?.t === "session.started" && typeof m.sessionId === "string" && match(m)) return m.sessionId;
  }
  return undefined;
}

function replyError(replies: unknown[]): string | undefined {
  for (const message of replies) {
    const m = message as { t?: unknown; message?: unknown };
    if (m?.t === "error" && typeof m.message === "string") return m.message;
  }
  return undefined;
}

/** One line saying how a tool call turned out. Names and results, never the words the user spoke. */
function toolOutcome(output: unknown): string {
  const result = output as { status?: unknown; error?: unknown; agent?: unknown; project?: unknown; conversation?: unknown } | null;
  const parts = [typeof result?.status === "string" ? result.status : "ok"];
  if (typeof result?.agent === "string") parts.push(`agent=${result.agent}`);
  if (typeof result?.project === "string") parts.push(`project=${result.project}`);
  if (typeof result?.conversation === "string") parts.push(`conversation=${result.conversation}`);
  if (typeof result?.error === "string") parts.push(`error=${result.error.slice(0, 160)}`);
  return parts.join(" ");
}
