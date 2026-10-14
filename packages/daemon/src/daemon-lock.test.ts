/**
 * One daemon per pew2 home.
 *
 * The bug this guards: a stray `bun run server.ts` started from a shell used the
 * same `~/.pew2` as the scheduled service, took its relay room after a blip, and
 * the service spent the rest of the day refused with a 409 nobody could see.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireDaemonLock,
  daemonLockPath,
  describeHeldLock,
  holderIsRunning,
  type LockHolder,
} from "./daemon-lock.js";
import { identityOf } from "./children.js";
import { startDaemon, type RunningDaemon } from "./testing/daemon-process.js";

const homes: string[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pew2-lock-"));
  homes.push(home);
  return home;
}

async function lockPath(): Promise<string> {
  const path = join(await tempHome(), ".pew2", "daemon.lock");
  await mkdir(dirname(path), { recursive: true });
  return path;
}

/** A pid that has certainly exited: a child that already ran to completion. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["bun", "--version"], { stdout: "ignore" });
  await child.exited;
  return child.pid;
}

async function readHolder(path: string): Promise<LockHolder> {
  return JSON.parse(await readFile(path, "utf8")) as LockHolder;
}

test("the lock lives in the pew2 home, so another home gets another lock", () => {
  expect(daemonLockPath({ PEW2_HOME: join("a", "home") })).toBe(join("a", "home", "daemon.lock"));
  expect(daemonLockPath({ PEW2_HOME: join("b", "home") })).not.toBe(
    daemonLockPath({ PEW2_HOME: join("a", "home") }),
  );
});

test("the first daemon takes the lock and records its pid and port", async () => {
  const path = await lockPath();

  const result = await acquireDaemonLock({ path, port: 8790 });

  expect(result.ok).toBe(true);
  const holder = await readHolder(path);
  expect(holder.pid).toBe(process.pid);
  expect(holder.port).toBe(8790);
  expect(holder.identity).toBe((await identityOf(process.pid))!);
  if (result.ok) result.lock.release();
});

test("a second daemon on the same home is refused and told who holds it", async () => {
  const path = await lockPath();
  // This test process plays the running daemon: it is alive and its identity
  // matches what it recorded, exactly as the scheduled service's would.
  const first = await acquireDaemonLock({ path, port: 8790 });
  expect(first.ok).toBe(true);

  const second = await acquireDaemonLock({ path, port: 8787, pid: process.pid + 1 });

  expect(second.ok).toBe(false);
  if (second.ok) throw new Error("unreachable");
  expect(second.holder.pid).toBe(process.pid);
  expect(second.holder.port).toBe(8790);
  const message = describeHeldLock(second);
  expect(message).toContain(`pid ${process.pid}`);
  expect(message).toContain("port 8790");
  expect(message).toContain(path);
  // Refusing must not take the lock away from the daemon that has it.
  expect((await readHolder(path)).pid).toBe(process.pid);
  if (first.ok) first.lock.release();
});

test("a lock left by a daemon that died is taken over", async () => {
  const path = await lockPath();
  // Names a pid that is gone, as a daemon killed outright leaves it.
  const pid = await deadPid();
  await writeFile(path, JSON.stringify({ pid, port: 8787, startedAt: "earlier" }));

  const result = await acquireDaemonLock({ path, port: 8790 });

  expect(result.ok).toBe(true);
  expect((await readHolder(path)).pid).toBe(process.pid);
  if (result.ok) result.lock.release();
});

test("a pid reused by an unrelated process does not hold the lock", async () => {
  // Alive, but not what wrote the lock: the identity no longer matches.
  expect(
    await holderIsRunning({ pid: process.pid, identity: "not-a-daemon.exe", startedAt: "" }, -1),
  ).toBe(false);
  // Our own pid in the file is a dead daemon's record the OS handed back to us.
  expect(await holderIsRunning({ pid: process.pid, startedAt: "" }, process.pid)).toBe(false);
  // Alive and the same identity: that is the running daemon.
  expect(
    await holderIsRunning(
      { pid: process.pid, identity: await identityOf(process.pid), startedAt: "" },
      -1,
    ),
  ).toBe(true);
});

test("an empty or corrupt lock file is treated as stale", async () => {
  const path = await lockPath();
  await writeFile(path, "{not json");

  const result = await acquireDaemonLock({ path, port: 1 });

  expect(result.ok).toBe(true);
  expect((await readHolder(path)).port).toBe(1);
  if (result.ok) result.lock.release();
});

test("the bound port replaces the configured one", async () => {
  const path = await lockPath();
  const result = await acquireDaemonLock({ path, port: 0 });
  if (!result.ok) throw new Error("expected the lock");

  await result.lock.setPort(54321);

  expect((await readHolder(path)).port).toBe(54321);
  result.lock.release();
});

test("release removes the lock, but never one another daemon has taken since", async () => {
  const path = await lockPath();
  const result = await acquireDaemonLock({ path });
  if (!result.ok) throw new Error("expected the lock");

  // Someone reclaimed it (after deciding this daemon was gone).
  await writeFile(path, JSON.stringify({ pid: process.pid + 1, startedAt: "" }));
  result.lock.release();
  expect((await readHolder(path)).pid).toBe(process.pid + 1);

  // While it is ours, release removes it.
  await rm(path);
  const again = await acquireDaemonLock({ path });
  if (!again.ok) throw new Error("expected the lock");
  again.lock.release();
  expect(await Bun.file(path).exists()).toBe(false);
});

test("a real second daemon on the same home refuses to start; another home is fine", async () => {
  const first = await startDaemon();
  daemons.push(first);

  // Same HOME, so the same ~/.pew2 and the same pairing: refused.
  const refused = await startDaemon({ home: first.home }).then(
    (daemon) => {
      daemons.push(daemon);
      return "started";
    },
    (error: Error) => error.message,
  );
  expect(refused).toContain("Another pew2 daemon is already running");
  expect(refused).toContain(`port ${first.port}`);
  // The refusal names who holds it, and must not hand out the pairing.
  expect(refused).not.toContain(first.token);
  expect(refused).not.toContain(first.key);

  // The first is untouched by the attempt.
  expect(first.died()).toBeUndefined();
  expect((await fetch(`http://127.0.0.1:${first.port}/health`)).ok).toBe(true);

  // A different home is a different pairing, and runs alongside.
  const other = await startDaemon();
  daemons.push(other);
  expect(other.port).not.toBe(first.port);
}, 120_000);

test("a daemon that has stopped leaves the home free for the next one", async () => {
  // A home this test owns, so it outlives the first daemon's `stop`.
  const home = await tempHome();
  const first = await startDaemon({ home });
  await first.stop();

  // Stopped by signal on POSIX, which releases the lock; terminated outright
  // on Windows, which leaves a stale one behind. Either way the next start
  // must succeed: a lock naming a dead daemon holds nothing.
  const second = await startDaemon({ home });
  daemons.push(second);
  expect(second.died()).toBeUndefined();
}, 120_000);
