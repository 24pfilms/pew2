/**
 * The OrcaZeroViva dashboard, fetched from Orca's agent-core pipe.
 *
 * One fixed request, one forwarding target: the phone's `dash` frame carries no
 * parameters, and the only thing ever written to the pipe is the constant
 * `phone.dash.snapshot` request built here. The pipe broadcasts every agent-core
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

export type DashResult = { ok: true; snapshot: wire.DashSnapshot } | { ok: false; error: string };

/** One round trip; `rateLimited` is the only failure worth a retry. */
type Attempt = DashResult | { ok: false; rateLimited: true };

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
  private inFlight?: Promise<DashResult>;
  private last?: { at: number; snapshot: wire.DashSnapshot };
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
   * simplification: one global gate rather than a per-device limit. Fine for
   * one user; move to a per-`deviceId` bucket if more devices pair.
   */
  snapshot(): Promise<DashResult> {
    if (this.last && this.now() - this.last.at < REUSE_MS) {
      return Promise.resolve({ ok: true, snapshot: this.last.snapshot });
    }
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<DashResult> {
    const started = this.now();
    let attempt = await this.ask();
    if (!attempt.ok && "rateLimited" in attempt) {
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? RATE_LIMIT_RETRY_MS));
      attempt = await this.ask();
    }
    const result: DashResult = attempt.ok || !("rateLimited" in attempt) ? attempt : { ok: false, error: DASH_ERRORS.busy };
    if (result.ok) this.last = { at: this.now(), snapshot: result.snapshot };
    this.log(`[dash] ${result.ok ? "ok" : "failed"} in ${this.now() - started}ms`);
    return result;
  }

  /** One connection, one request, one answer. Never rejects. */
  private ask(): Promise<Attempt> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const socket = createConnection(this.options.pipePath);
      socket.setEncoding("utf8");
      let buffer = "";
      let received = 0;
      let settled = false;

      const finish = (attempt: Attempt) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(attempt);
      };
      const timer = setTimeout(() => finish({ ok: false, error: DASH_ERRORS.timeout }), this.options.timeoutMs ?? DASH_TIMEOUT_MS);

      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "phone.dash.snapshot", requestId })}\n`);
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
          const answer = readLine(line, requestId);
          if (answer) finish(answer);
          newline = buffer.indexOf("\n");
        }
      });
    });
  }
}

/** Our answer, or undefined for a line that belongs to someone else. */
function readLine(line: string, requestId: string): Attempt | undefined {
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
  const snapshot = wire.DashSnapshot.safeParse(reply.data.data);
  return snapshot.success ? { ok: true, snapshot: snapshot.data } : { ok: false, error: DASH_ERRORS.unreadable };
}
