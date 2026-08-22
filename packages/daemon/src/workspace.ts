/**
 * Where an agent process runs when nobody asked for a directory.
 *
 * Under launchd the daemon starts with cwd `/`, and an agent that treats its
 * cwd as a project root then writes straight into the filesystem root — GG
 * Coder failed exactly this way, `mkdir '/.gg'`, and its session history never
 * reached the phone. A headless daemon has no meaningful cwd of its own, so the
 * home directory is the honest default: it is where a terminal would have put
 * the agent, and it is always writable by the user the daemon runs as.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parse } from "node:path";
import { envValue } from "./providers/registry.js";

/**
 * Is `dir` the Windows directory, or inside it?
 *
 * Compared segment by segment rather than by string prefix, so `C:\WINDOWSX`
 * is not mistaken for a child of `C:\WINDOWS`; case-insensitively and across
 * both separators, because that is how Windows itself compares paths and the
 * variable arrives spelled `SystemRoot` or `windir` depending on who set it.
 */
function insideSystemRoot(dir: string, env: NodeJS.ProcessEnv): boolean {
  const root = envValue(env, "SystemRoot", true) ?? envValue(env, "windir", true);
  if (!root) return false;

  const segments = (path: string) =>
    path.toLowerCase().split(/[/\\]/).filter(Boolean);
  const rootParts = segments(root);
  const dirParts = segments(dir);
  if (rootParts.length === 0 || dirParts.length < rootParts.length) return false;
  return rootParts.every((part, i) => dirParts[i] === part);
}

/**
 * Resolve the working directory for a spawned agent.
 *
 * Order: an explicit request from the client, then `PEW2_WORKSPACE`, then the
 * daemon's own cwd when it is a real directory, and finally the user's home.
 */
export function resolveWorkspace(
  requested?: string,
  env: NodeJS.ProcessEnv = process.env,
  daemonCwd: string = process.cwd(),
  home: string = homedir(),
): string {
  const explicit = requested ?? env.PEW2_WORKSPACE;
  if (explicit) return explicit;

  // A filesystem root is never a sane project directory. It is exactly what
  // launchd hands the daemon, and spawning an agent there writes its state
  // into `/` or fails trying.
  if (daemonCwd === parse(daemonCwd).root) return home;

  // The same failure wearing a Windows coat, and the reason the root check was
  // not enough. A Scheduled Task starts in `C:\WINDOWS\system32` — a real,
  // existing directory that no user ever picked — and GG Coder's probe died
  // there on `EPERM: mkdir 'C:\WINDOWS\system32\.gg'`. Writability is not the
  // test to apply either: `access(W_OK)` reports `C:\WINDOWS` as writable and
  // creating a directory in it still fails.
  if (insideSystemRoot(daemonCwd, env)) return home;

  if (existsSync(daemonCwd)) return daemonCwd;
  return home;
}

/**
 * The project name people actually say: the last segment of a path.
 *
 * `/Users/kenkai/gg-projects/pew2` is unreadable in a notification banner;
 * `pew2` is the whole point of the message. Undefined for a root or an empty
 * path, so a caller can leave the name out rather than print a slash.
 */
export function folderName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // Trailing slashes would otherwise yield an empty last segment.
  const segments = cwd.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1];
}
