/**
 * One daemon per pew2 home.
 *
 * Two daemons reading the same `pairing.json` are not two servers side by side:
 * they are two machines claiming one relay room. The relay keeps whichever is
 * attached and refuses the other with a 409 for as long as the first keeps
 * answering keepalives, so the phone ends up talking to whichever one happened
 * to reconnect first after a blip. That is how a stray `bun run server.ts` from
 * a shell took the room from the scheduled service: nothing on either side said
 * there were two.
 *
 * So the second one refuses to start, and says why. The lock lives in the pew2
 * home rather than anywhere machine-wide, because the home is what the two would
 * actually share — a test daemon under a temporary `HOME` is a different pairing
 * and is allowed to run beside the real one.
 *
 * A lock file outlives a daemon that is killed outright, so a file on its own
 * proves nothing. The holder counts only while its pid is alive *and* still
 * carries the identity recorded when it took the lock — the same pid-reuse
 * defence `children.ts` uses before it signals anything. A stale file costs the
 * next start one read; trusting it would lock the machine out of its own phone.
 */
import { open, readFile, unlink } from "node:fs/promises";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { alive, identityOf } from "./children.js";
import { userProvidersDir } from "./providers/registry.js";

/** What the lock file records about the daemon that holds it. */
export interface LockHolder {
  pid: number;
  /** The port it listens on; the configured one until it is actually bound. */
  port?: number;
  /** How the OS named the holder when it took the lock. See `identityOf`. */
  identity?: string;
  startedAt: string;
}

export interface DaemonLock {
  readonly path: string;
  /** Record the port the server actually bound, which `PEW2_PORT=0` only learns later. */
  setPort(port: number): Promise<void>;
  /**
   * Remove the lock, if it is still this daemon's.
   *
   * Synchronous so it can run from a process `exit` handler, which is the only
   * place every orderly shutdown path passes through.
   */
  release(): void;
}

export type LockResult =
  { ok: true; lock: DaemonLock } | { ok: false; path: string; holder: LockHolder };

/** `~/.pew2/daemon.lock`, or `$PEW2_HOME/daemon.lock` when overridden. */
export function daemonLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userProvidersDir(env)), "daemon.lock");
}

/** Is the process a lock file names still the one that wrote it? */
export async function holderIsRunning(holder: LockHolder, self = process.pid): Promise<boolean> {
  // Our own pid in the file is a dead daemon's record whose number the OS has
  // since handed to us — a service restart can do exactly that.
  if (holder.pid === self) return false;
  if (!alive(holder.pid)) return false;
  // No identity means it could not be read when the lock was taken. The pid
  // being alive is then the best evidence there is.
  if (holder.identity === undefined) return true;
  return (await identityOf(holder.pid)) === holder.identity;
}

/** The holder a lock file describes, or undefined for one that is empty or corrupt. */
function parseHolder(text: string): LockHolder | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockHolder>;
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
      return undefined;
    }
    return {
      pid: value.pid,
      port: typeof value.port === "number" ? value.port : undefined,
      identity: typeof value.identity === "string" ? value.identity : undefined,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    };
  } catch {
    return undefined;
  }
}

/**
 * Take the lock for this pew2 home, or report who holds it.
 *
 * Created with `wx`, so of two daemons starting at the same moment exactly one
 * gets the file. A stale file is removed and the create tried again; the removal
 * is skipped if the file changed since it was judged stale, so a daemon that
 * reclaimed it first is not unlocked by a second one that read the old contents.
 */
export async function acquireDaemonLock(
  options: {
    path?: string;
    port?: number;
    pid?: number;
    isRunning?: (holder: LockHolder) => Promise<boolean>;
  } = {},
): Promise<LockResult> {
  const path = options.path ?? daemonLockPath();
  const pid = options.pid ?? process.pid;
  const isRunning = options.isRunning ?? ((holder: LockHolder) => holderIsRunning(holder, pid));
  mkdirSync(dirname(path), { recursive: true });

  const mine: LockHolder = {
    pid,
    port: options.port,
    identity: await identityOf(pid),
    startedAt: new Date().toISOString(),
  };

  // Three tries covers a stale file plus one racing daemon; anything past that
  // is a filesystem misbehaving, and saying so beats looping.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(mine));
      } finally {
        await handle.close();
      }
      return { ok: true, lock: heldLock(path, mine) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const text = await readIfPresent(path);
    // Released between the create and the read: just try again.
    if (text === undefined) continue;

    const holder = parseHolder(text);
    if (holder && (await isRunning(holder))) return { ok: false, path, holder };

    if ((await readIfPresent(path)) === text) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  throw new Error(`could not take the daemon lock at ${path}: it keeps changing underneath`);
}

/** A file's text, or undefined when there is no file. Any other failure is real. */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function heldLock(path: string, holder: LockHolder): DaemonLock {
  let current = holder;
  /** Only a file that still names this daemon is ours to touch. */
  const stillOurs = () => {
    try {
      return parseHolder(readFileSync(path, "utf8"))?.pid === holder.pid;
    } catch {
      return false;
    }
  };
  return {
    path,
    async setPort(port) {
      if (!stillOurs()) return;
      current = { ...current, port };
      await writeFileAtomic(path, JSON.stringify(current));
    },
    release() {
      if (!stillOurs()) return;
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

/** The refusal a second daemon prints before it exits. */
export function describeHeldLock(result: { path: string; holder: LockHolder }): string {
  const { holder, path } = result;
  const where = holder.port ? `, port ${holder.port}` : "";
  const since = holder.startedAt ? `, started ${holder.startedAt}` : "";
  return (
    `Another pew2 daemon is already running for this pew2 home (pid ${holder.pid}${where}${since}).\n` +
    `Two daemons on one pairing fight over the relay, so this one is not starting.\n` +
    `Stop the other one first, or give this one its own PEW2_HOME. Lock: ${path}`
  );
}
