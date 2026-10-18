/**
 * Promises to call the user back, kept until the phone says it rang.
 *
 * "Tell the developer to do it and call me when it's done" used to rest on one
 * message: `session.idle`, said once at the moment the turn ended. Two ordinary
 * events turned that into silence. The relay drops for a minute or two at a time
 * (it holds a dropped daemon out for up to 90 s), and a turn ending inside that
 * window was announced to nobody. And a job that dies without ending — the agent
 * killed, or hung on a command that never returns — never says idle at all.
 *
 * So a job asked for by voice becomes a promise held here, on disk. When the
 * turn ends it becomes a call (`callback.due`) that is resent on every phone
 * `hello` and on a timer until the phone answers `callback.ack`. A job that goes
 * quiet for too long gets its own call saying so, and the promise still stands
 * for the real ending. A daemon that restarts mid-job reports it rather than
 * forgetting it.
 */
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { noticeBody, noticeTitle, type wire } from "@pew2/protocol";
import { writeFileAtomic } from "./atomic-file.js";

/** Who ran the job and what it last said: what a call is worded from. */
export interface CallbackOrigin {
  providerId?: string;
  folder?: string;
  agentName?: string;
  lastText?: string;
}

/** What the ledger needs to know about a running job, from the daemon. */
export interface JobState {
  working: boolean;
  /** When the agent last said or did anything in this conversation. */
  lastActivityAt?: number;
}

/** A job someone asked to be called about, still running. */
interface Waiting {
  id: string;
  sessionId: string;
  promisedAt: number;
  origin: CallbackOrigin;
  /** The "may be stuck" call has been made for this job. */
  warnedStalled?: boolean;
  /** Stop was pressed: however the turn ends, the job did not finish. */
  stopped?: boolean;
}

/** A call to make, held until the phone confirms it. */
interface Due {
  message: wire.CallbackDue;
  dueAt: number;
  sentAt?: number;
  sends: number;
}

interface Stored {
  version: 1;
  waiting: Waiting[];
  due: Due[];
}

export interface CallbackLedgerOptions {
  /** Where the promises live, so a daemon restart cannot lose one. */
  path: string;
  /** To every connected client, on every transport. */
  send: (message: wire.CallbackDue) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export class CallbackLedger {
  /** Resend an unconfirmed call this often while it is unconfirmed. */
  static readonly RESEND_MS = 60_000;
  /** A call nobody confirmed for this long is dropped: the moment has passed. */
  static readonly EXPIRE_MS = 12 * 60 * 60 * 1000;
  /**
   * Silence long enough to call about. Long, because a build or a test run can
   * legitimately sit in one command for many minutes; the call says "may be".
   */
  static readonly STALL_MS = 20 * 60 * 1000;
  /**
   * How long a job may sit ended-but-unsettled (its conversation idle or gone)
   * before the ledger stops waiting for the idle and calls anyway.
   */
  static readonly ENDED_GRACE_MS = 2 * 60 * 1000;
  /** How long after a ring a call about that conversation is taken as answering it. */
  static readonly ANSWER_WINDOW_MS = 10 * 60 * 1000;

  private waiting: Waiting[] = [];
  private due: Due[] = [];
  private writes: Promise<void> = Promise.resolve();
  /**
   * Only a ledger that has loaded the file writes it. The real daemon loads at
   * startup (`server.ts`); a Daemon built in a test never does, so it can never
   * overwrite the calls the live daemon is holding in the user's home.
   */
  private persisting = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: CallbackLedgerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(`[callback] ${line}`));
  }

  /**
   * Read what an earlier daemon left behind, merged into anything already held.
   *
   * A job still waiting from before the restart cannot be finishing under this
   * process — its agent was a child of the old one — so it is reported as
   * stopped rather than silently forgotten.
   */
  async load(): Promise<void> {
    this.persisting = true;
    const path = this.options.path;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      console.error(`[callback] could not read ${path}; starting empty:`, error);
      return;
    }
    let stored: Partial<Stored> | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") stored = parsed as Partial<Stored>;
    } catch {
      // Reported below, with the copy kept.
    }
    if (!stored) {
      // Kept aside rather than overwritten by the next save: whatever calls it
      // held are lost to this daemon, but not to someone looking for them.
      const aside = `${path}.corrupt-${this.now()}`;
      try {
        await rename(path, aside);
        console.error(`[callback] ${path} was not readable; moved it to ${aside} and started empty`);
      } catch (error) {
        // Not worth refusing to start over: the calls in it are lost either way.
        console.error(`[callback] ${path} was not readable and could not be moved aside; it will be replaced:`, error);
      }
      return;
    }
    const due = (Array.isArray(stored.due) ? stored.due : []).filter(isDue);
    const waiting = (Array.isArray(stored.waiting) ? stored.waiting : []).filter(isWaiting);
    for (const call of due) this.due.push({ ...call, sentAt: undefined });
    for (const job of waiting) {
      this.makeDue(job, "failed", {
        title: `${noticeTitle(job.origin)} may have stopped`,
        body: "pew2 restarted on the PC while this job was running, so it may not have finished. Have a look.",
      });
    }
    if (this.due.length > 0) this.log(`${this.due.length} call(s) carried over from before the restart`);
    this.save();
  }

  /** A job the user asked to be called about. One promise per conversation. */
  promise(sessionId: string, origin: CallbackOrigin): string {
    const open = this.waiting.find((job) => job.sessionId === sessionId);
    if (open) return open.id;
    const id = `cb_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // Who, not what: the last words known now belong to the previous turn, and
    // quoting them for this one would report the wrong job as done.
    const { lastText: _previousTurn, ...who } = origin;
    this.waiting.push({ id, sessionId, promisedAt: this.now(), origin: who });
    this.log(`promised ${id}: call when ${noticeTitle(origin)} finishes`);
    this.save();
    return id;
  }

  /**
   * The conversation's turn has ended. Returns the call's id when a promise was
   * kept, so `session.idle` can say the call is handled.
   */
  settle(
    sessionId: string,
    result: { ok: true } | { ok: false; error: string },
    origin: CallbackOrigin,
  ): string | undefined {
    const job = this.waiting.find((entry) => entry.sessionId === sessionId);
    if (!job) return undefined;
    // What the agent said is only known now; who it was came with the promise.
    const about = { ...job.origin, ...defined(origin) };
    if (job.stopped) {
      // A stop ends the turn cleanly, but the job is not done: what was queued
      // behind it went back to the composer unsent. "Done" here would be a lie.
      this.makeDue(job, "failed", {
        title: `${noticeTitle(about)} stopped`,
        body: "Stopped before it finished, so the job may not be done. Have a look.",
      });
    } else if (result.ok) {
      this.makeDue(job, "done", { title: noticeTitle(about), body: noticeBody(about.lastText) });
    } else {
      this.makeDue(job, "failed", {
        title: `${noticeTitle(about)} stopped`,
        body: `The job ended with an error: ${clip(result.error, 240)}. Have a look before trusting the result.`,
      });
    }
    this.save();
    return job.id;
  }

  /**
   * Someone pressed stop (or Orca was told to stop) in a conversation with a
   * promise open. The turn will still end and be settled; this only makes sure
   * that ending is not reported as done.
   */
  stop(sessionId: string) {
    const job = this.waiting.find((entry) => entry.sessionId === sessionId);
    if (!job || job.stopped) return;
    job.stopped = true;
    this.log(`${job.id} was stopped before it finished`);
    this.save();
  }

  /**
   * Calls the phone confirmed recently, by conversation: answering the ring
   * opens a call with Orca about that conversation, and she has to know why
   * she is calling. Memory only; a ring answered after a restart just opens
   * an ordinary call.
   */
  private readonly rung = new Map<string, { message: wire.CallbackDue; at: number }>();

  /**
   * The call just rung for this conversation, once, if it was confirmed within
   * `ANSWER_WINDOW_MS`. Taken, not peeked: only the first call after the ring
   * opens with the result.
   */
  takeRung(sessionId: string): wire.CallbackDue | undefined {
    const rung = this.rung.get(sessionId);
    this.rung.delete(sessionId);
    if (!rung || this.now() - rung.at > CallbackLedger.ANSWER_WINDOW_MS) return undefined;
    return rung.message;
  }

  /** The phone rang or showed it. */
  ack(id: string) {
    const call = this.due.find((entry) => entry.message.id === id);
    if (!call) return;
    this.due = this.due.filter((entry) => entry !== call);
    this.rung.set(call.message.sessionId, { message: call.message, at: this.now() });
    const seconds = Math.round((this.now() - call.dueAt) / 1000);
    this.log(`phone confirmed ${id} (${call.message.outcome}) ${seconds}s after it was due, ${call.sends} send(s)`);
    this.save();
  }

  /**
   * Every unconfirmed call, for a device that has just said hello.
   *
   * Not counted as a send: the device saying hello may not be the phone (a
   * desktop client, the CLI), and counting it would hold the phone's own
   * resend back by a minute.
   */
  pending(): wire.CallbackDue[] {
    if (this.due.length > 0) this.log(`restating ${this.due.length} owed call(s) to a device that said hello`);
    return this.due.map((call) => call.message);
  }

  /**
   * Run every ~30 s: close out jobs that ended without saying so, warn about
   * jobs gone quiet, resend unconfirmed calls, drop ones too old to matter.
   */
  tick(jobState: (sessionId: string) => JobState | undefined) {
    const now = this.now();
    let changed = false;
    for (const job of [...this.waiting]) {
      const state = jobState(job.sessionId);
      const lastSign = Math.max(job.promisedAt, state?.lastActivityAt ?? 0);
      const quiet = now - lastSign;
      const who = job.origin.agentName ?? "the agent";
      // Ended without the turn settling the promise: the conversation closed, or
      // a turn ran outside the prompt path (an agent handing text back at turn
      // end). Nothing will ever settle it now, so this is the last call, not a
      // warning — and it is made after a warning too, so no job is stranded on
      // "I'll still call". The grace covers the moment between a turn ending
      // and the idle that settles it.
      if (quiet >= CallbackLedger.ENDED_GRACE_MS && (!state || !state.working)) {
        changed = true;
        if (!state) {
          this.makeDue(job, "failed", {
            title: `${noticeTitle(job.origin)} stopped`,
            body: `${who}'s conversation closed on the PC without saying it finished. Have a look.`,
          });
        } else {
          this.makeDue(job, job.stopped ? "failed" : "done", {
            title: job.stopped ? `${noticeTitle(job.origin)} stopped` : noticeTitle(job.origin),
            body: job.stopped
              ? "Stopped before it finished, so the job may not be done. Have a look."
              : `${who} is no longer working on it but never said how it went. Have a look.`,
          });
        }
        continue;
      }
      if (job.warnedStalled || quiet < CallbackLedger.STALL_MS) continue;
      changed = true;
      job.warnedStalled = true;
      const minutes = Math.round(quiet / 60_000);
      this.enqueue({
        id: `${job.id}_stalled`,
        sessionId: job.sessionId,
        outcome: "stalled",
        title: `${noticeTitle(job.origin)} may be stuck`,
        body: `No word from ${who} for ${minutes} minutes. I'll still call when it finishes.`,
        ...defined({ providerId: job.origin.providerId, folder: job.origin.folder }),
      });
    }
    for (const call of [...this.due]) {
      if (now - call.dueAt > CallbackLedger.EXPIRE_MS) {
        this.due = this.due.filter((entry) => entry !== call);
        changed = true;
        this.log(`gave up on ${call.message.id}: the phone never confirmed it (${call.sends} send(s))`);
        continue;
      }
      if (call.sentAt === undefined || now - call.sentAt >= CallbackLedger.RESEND_MS) {
        this.noteSent(call, now, "resend");
        this.options.send(call.message);
      }
    }
    if (changed) this.save();
  }

  /**
   * Send every unconfirmed call now, rather than at its next minute.
   *
   * For the moment the relay lets this daemon back in: a phone that stayed in
   * the room through the outage never says hello again, so without this the
   * call waited on the resend timer — up to a minute after the link was back
   * (2026-10-18 15:19Z: online at :07, rung at :56).
   */
  resendNow(why: string) {
    const now = this.now();
    for (const call of this.due) {
      this.noteSent(call, now, why);
      this.options.send(call.message);
    }
  }

  /** Waiting jobs and unconfirmed calls, for tests and diagnostics. */
  snapshot(): { waiting: string[]; due: string[] } {
    return { waiting: this.waiting.map((job) => job.id), due: this.due.map((call) => call.message.id) };
  }

  private makeDue(job: Waiting, outcome: "done" | "failed", words: { title: string; body: string }) {
    this.waiting = this.waiting.filter((entry) => entry !== job);
    // A "may be stuck" still unconfirmed is out of date now the real ending is
    // known; ringing it after a reconnect, just before the ending, is noise.
    this.due = this.due.filter((entry) => entry.message.id !== `${job.id}_stalled`);
    this.enqueue({
      id: job.id,
      sessionId: job.sessionId,
      outcome,
      ...words,
      ...defined({ providerId: job.origin.providerId, folder: job.origin.folder }),
    });
  }

  private enqueue(fields: Omit<wire.CallbackDue, "t">) {
    const message: wire.CallbackDue = { t: "callback.due", ...fields };
    const call: Due = { message, dueAt: this.now(), sends: 0 };
    this.due.push(call);
    this.log(`due ${message.id} (${message.outcome}): ${message.title}`);
    this.noteSent(call, call.dueAt, "first send");
    this.options.send(message);
    this.save();
  }

  private noteSent(call: Due, now: number, why: string) {
    call.sentAt = now;
    call.sends += 1;
    if (call.sends > 1) this.log(`sent ${call.message.id} again (${why}, send ${call.sends})`);
  }

  /** Written in order, each write after the last, so an older state never lands last. */
  private save() {
    if (!this.persisting) return;
    const stored: Stored = { version: 1, waiting: this.waiting, due: this.due };
    const data = JSON.stringify(stored, null, 2);
    const path = this.options.path;
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFileAtomic(path, data);
      })
      .catch((error: unknown) => {
        // Loud, not fatal: the calls are still held in memory and still ring;
        // only surviving a restart is lost.
        console.error(`[callback] could not save ${path}:`, error);
      });
  }

  /** Settle pending writes; for tests. */
  flush(): Promise<void> {
    return this.writes;
  }
}

/** A stored call with what resending and confirming it needs. */
function isDue(value: unknown): value is Due {
  const call = value as Partial<Due> | null;
  return (
    typeof call?.dueAt === "number" &&
    typeof call.sends === "number" &&
    typeof call.message?.id === "string" &&
    typeof call.message.sessionId === "string"
  );
}

/** A stored promise with what reporting it needs. */
function isWaiting(value: unknown): value is Waiting {
  const job = value as Partial<Waiting> | null;
  return (
    typeof job?.id === "string" &&
    typeof job.sessionId === "string" &&
    typeof job.promisedAt === "number" &&
    typeof job.origin === "object" &&
    job.origin !== null
  );
}

/** Drop undefined fields, so a spread never overwrites a known value with nothing. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
