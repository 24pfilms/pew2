/**
 * The OrcaZeroViva dashboard, fetched from Orca's agent-core pipe.
 *
 * Two request shapes, both built here from constants: `phone.dash.snapshot`, or
 * `phone.view.get` with a page name the phone chose from a fixed enum (checked
 * by the wire schema before it gets here). Nothing else is ever written to the
 * pipe. The pipe broadcasts every agent-core
 * event (chat streams, heartbeats) to every client, so every line that is not
 * the answer to our own `requestId` is dropped unread.
 *
 * The reply is re-validated against `wire.DashSnapshot`, which strips unknown
 * keys, so a field added on the PC by mistake still never reaches the phone.
 * Nothing is logged but the outcome and the elapsed time.
 *
 * Spec: L:\Pew_2\tasks\phone-dashboard-pew2-spec.md (section 4).
 */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { wire } from "@pew2/protocol";
import { z } from "zod";

export const DASH_TIMEOUT_MS = 5_000;
/** Everything read from the pipe in one request, broadcasts included. */
export const MAX_BUFFERED_BYTES = 256 * 1024;
/** The answer line itself. */
export const MAX_REPLY_BYTES = 64 * 1024;
/** A snapshot younger than this is reused rather than asked for again. */
export const REUSE_MS = 2_000;
const RATE_LIMIT_RETRY_MS = 1_000;

export const DASH_ERRORS = {
  notRunning: "Orca isn't running on this computer.",
  switchedOff: "The phone dashboard is off. Turn it on in Orca: Settings › Privacy & data.",
  timeout: "Orca didn't answer. Try again.",
  unreadable: "Orca sent something this version can't read. Update pew2.",
  busy: "Orca is busy. Try again.",
  orcaTooOld: "Orca on this computer is too old for the phone dashboard. Update Orca.",
  failed: "Orca couldn't build the dashboard. Try again.",
  disabled: "Dashboard isn't enabled on this computer.",
} as const;

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
export type DashResult = { ok: true; snapshot: wire.DashSnapshot } | { ok: false; error: string };
export type ViewResult = Outcome<wire.DashView>;

/** One round trip; `rateLimited` is the only failure worth a retry. */
type Attempt<T> = Outcome<T> | { ok: false; rateLimited: true };

/** What goes on the wire to Orca, and how its answer is read. */
interface Call<T> {
  type: "phone.dash.snapshot" | "phone.view.get";
  view?: wire.DashViewName;
  parse: (data: unknown) => T | undefined;
}

export interface OrcaDashOptions {
  pipePath: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Where agent-core listens: `platform/windows.ts` and `platform/{darwin,linux}.ts` in Orca. */
export function orcaPipePath(username: string = userInfo().username, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\orca-zero-viva-${username}` : `/tmp/orca-zero-viva-${username}.sock`;
}

/** Opt-in: only `PEW2_ORCA_DASHBOARD=1` turns the dashboard on, so nobody else ever sees it. */
export function orcaDashFromEnv(env: NodeJS.ProcessEnv): OrcaDash | undefined {
  return env.PEW2_ORCA_DASHBOARD === "1" ? new OrcaDash({ pipePath: orcaPipePath() }) : undefined;
}

/** agent-core's `AgentResponse`, read only as far as the daemon needs it. */
const PipeReply = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), retryable: z.boolean().optional() }).optional(),
});

export class OrcaDash {
  private readonly inFlight = new Map<string, Promise<Outcome<unknown>>>();
  private readonly last = new Map<string, { at: number; value: unknown }>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: OrcaDashOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /**
   * The current snapshot. Concurrent callers share one pipe connection, and a
   * snapshot under `REUSE_MS` old is answered without asking again.
   *
   * simplification: one global gate per page rather than a per-device limit.
   * Fine for one user; move to a per-`deviceId` bucket if more devices pair.
   */
  async snapshot(): Promise<DashResult> {
    const result = await this.gated("snapshot", {
      type: "phone.dash.snapshot",
      parse: (data) => {
        const parsed = wire.DashSnapshot.safeParse(data);
        return parsed.success ? parsed.data : undefined;
      },
    });
    return result.ok ? { ok: true, snapshot: result.value } : result;
  }

  /** One page's titles and dates, same coalescing and reuse as the snapshot. */
  view(view: wire.DashViewName): Promise<ViewResult> {
    return this.gated(`view:${view}`, {
      type: "phone.view.get",
      view,
      parse: (data) => {
        const parsed = wire.DashView.safeParse(data);
        return parsed.success && parsed.data.view === view ? parsed.data : undefined;
      },
    });
  }

  /** Shared by both calls. The cache holds values already parsed by `call.parse`, which is idempotent. */
  private async gated<T>(key: string, call: Call<T>): Promise<Outcome<T>> {
    const cached = this.last.get(key);
    let result: Outcome<unknown>;
    if (cached && this.now() - cached.at < REUSE_MS) {
      result = { ok: true, value: cached.value };
    } else {
      let running = this.inFlight.get(key);
      if (!running) {
        running = this.fetch(key, call).finally(() => {
          this.inFlight.delete(key);
        });
        this.inFlight.set(key, running);
      }
      result = await running;
    }
    if (!result.ok) return result;
    const value = call.parse(result.value);
    return value === undefined ? { ok: false, error: DASH_ERRORS.unreadable } : { ok: true, value };
  }

  private async fetch<T>(key: string, call: Call<T>): Promise<Outcome<unknown>> {
    const started = this.now();
    let attempt = await this.ask(call);
    if (!attempt.ok && "rateLimited" in attempt) {
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? RATE_LIMIT_RETRY_MS));
      attempt = await this.ask(call);
    }
    const result: Outcome<unknown> = attempt.ok || !("rateLimited" in attempt) ? attempt : { ok: false, error: DASH_ERRORS.busy };
    if (result.ok) this.last.set(key, { at: this.now(), value: result.value });
    this.log(`[dash] ${key.split(":")[0]} ${result.ok ? "ok" : "failed"} in ${this.now() - started}ms`);
    return result;
  }

  /** One connection, one request, one answer. Never rejects. */
  private ask<T>(call: Call<T>): Promise<Attempt<T>> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const socket = createConnection(this.options.pipePath);
      socket.setEncoding("utf8");
      let buffer = "";
      let received = 0;
      let settled = false;

      const finish = (attempt: Attempt<T>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(attempt);
      };
      const timer = setTimeout(() => finish({ ok: false, error: DASH_ERRORS.timeout }), this.options.timeoutMs ?? DASH_TIMEOUT_MS);

      socket.on("connect", () => {
        const message = call.view ? { type: call.type, view: call.view, requestId } : { type: call.type, requestId };
        socket.write(`${JSON.stringify(message)}\n`);
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        const absent = error.code === "ENOENT" || error.code === "ECONNREFUSED";
        finish({ ok: false, error: absent ? DASH_ERRORS.notRunning : DASH_ERRORS.failed });
      });
      // A refused connection already ended above; a close here means Orca was
      // reached and hung up before answering.
      socket.on("close", () => finish({ ok: false, error: DASH_ERRORS.failed }));
      socket.on("data", (chunk: string) => {
        received += Buffer.byteLength(chunk);
        if (received > MAX_BUFFERED_BYTES) return finish({ ok: false, error: DASH_ERRORS.unreadable });
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1 && !settled) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const answer = readLine(line, requestId, call.parse);
          if (answer) finish(answer);
          newline = buffer.indexOf("\n");
        }
      });
    });
  }
}

/** Our answer, or undefined for a line that belongs to someone else. */
function readLine<T>(line: string, requestId: string, parse: (data: unknown) => T | undefined): Attempt<T> | undefined {
  // Cheap pre-check, so broadcast lines are never parsed at all.
  if (!line.includes(requestId)) return undefined;
  if (Buffer.byteLength(line) > MAX_REPLY_BYTES) return { ok: false, error: DASH_ERRORS.unreadable };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: DASH_ERRORS.unreadable };
  }
  const reply = PipeReply.safeParse(parsed);
  if (!reply.success) return { ok: false, error: DASH_ERRORS.unreadable };
  if (reply.data.requestId !== requestId) return undefined;
  if (!reply.data.ok) {
    const code = reply.data.error?.code;
    if (code === "TOOL_PERMISSION_DENIED") return { ok: false, error: DASH_ERRORS.switchedOff };
    if (code === "DATA_NOT_FOUND") return { ok: false, error: DASH_ERRORS.orcaTooOld };
    if (reply.data.error?.retryable === true) return { ok: false, rateLimited: true };
    return { ok: false, error: DASH_ERRORS.failed };
  }
  const value = parse(reply.data.data);
  return value === undefined ? { ok: false, error: DASH_ERRORS.unreadable } : { ok: true, value };
}
