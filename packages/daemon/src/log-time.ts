/**
 * Put the time on every line the daemon logs.
 *
 * The service's stdout and stderr go straight to files, and a log line without a
 * time cannot answer the question it is opened for: when did the relay drop,
 * and for how long. Patching `console` once at startup covers every existing
 * call site without touching them.
 */
const STAMPED = Symbol.for("pew2.console.stamped");

type Level = "log" | "info" | "warn" | "error";

export function stampConsole(
  target: Pick<Console, Level> = console,
  now: () => Date = () => new Date(),
): void {
  const marked = target as unknown as Record<symbol, boolean>;
  // Once only: a second patch would stamp every line twice.
  if (marked[STAMPED]) return;
  marked[STAMPED] = true;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => original(now().toISOString(), ...args);
  }
}
