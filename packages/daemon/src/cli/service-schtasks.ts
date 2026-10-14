/**
 * Keeping the daemon alive on Windows, via a Scheduled Task.
 *
 * Windows has a real service manager, and it is the wrong tool here: a true
 * service needs Administrator to register, runs in session 0, and would spawn
 * every coding agent outside the user's desktop session and away from their
 * environment. Task Scheduler registers per-user with no elevation, which is
 * what an install script run from an ordinary shell can actually do.
 *
 * ## How a task becomes a keepalive
 *
 * Task Scheduler has no `KeepAlive`. `RestartOnFailure` is not it either: that
 * fires when an action *fails*, and the self-updater ends the daemon with exit
 * 0, which is a success. Under that setting an update would swap the binary,
 * exit cleanly, and never come back.
 *
 * So the restart is built from two settings that do apply, and the combination
 * is the whole trick:
 *
 * - a **logon trigger with a repetition** of one minute, so Windows attempts to
 *   start the task continuously, for ever; and
 * - **`MultipleInstancesPolicy: IgnoreNew`**, which does not start a new
 *   instance while one is already running.
 *
 * Together they mean: while the daemon is up, every attempt is ignored; the
 * moment it exits, the next attempt starts it. That is a poll rather than a
 * supervisor, so the worst-case gap is the repetition interval — a minute,
 * against launchd's ten-second throttle. Acceptable for an update restart, and
 * the reason `update/scheduler.ts` only ever exits when the daemon is idle.
 *
 * `ExecutionTimeLimit: PT0S` disables the three-day default kill, which would
 * otherwise terminate a long-lived daemon on a schedule.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { logDir } from "../logs.js";
import { envValue } from "../providers/registry.js";
import {
  LABEL,
  programArguments,
  type CommandResult,
  type InstallOptions,
  type ServiceStatus,
} from "./service-shared.js";

/** Task Scheduler's own name for the job. */
export const TASK_NAME = LABEL;

/**
 * Where the generated task XML is kept.
 *
 * Written to a stable path because it is also the marker `supervisorInstalled()`
 * reads: it is the one artefact of a Windows install that exists as a file. The
 * same caveat applies as to the launchd plist — someone can delete the task and
 * leave the file — but the file is never written unless an install ran, which is
 * the question being asked.
 */
export function taskXmlPath(home = homedir()): string {
  return join(home, ".pew2", "service", `${TASK_NAME}.xml`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Quote one argument of a Windows command line.
 *
 * Task Scheduler hands `Arguments` to the process as a single string, which is
 * split by the same rules as any other command line, so a path containing a
 * space has to be quoted or it arrives as two arguments.
 */
function quoteArgument(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function buildTaskXml(options: InstallOptions = {}): string {
  const program = programArguments(options.bunPath);
  const logs = logDir(options.env);
  const port = options.port ?? Number(options.env?.PEW2_PORT ?? 8787);
  const username = options.env?.USERNAME ?? userInfo().username;
  const userId = options.env?.USERDOMAIN ? `${options.env.USERDOMAIN}\\${username}` : username;

  // A task carries no environment of its own, and unlike launchd and systemd
  // there is no per-variable field to set. So the daemon is started through
  // `cmd /c` with the variables assigned inline, which is also what lets stdout
  // be redirected to the log files the daemon rotates.
  const assignments = [`set "PEW2_PORT=${port}"`];
  // Case-insensitively, because a Windows env block spells this `Path` and the
  // whole point of carrying it is that a task inherits none of the user's own.
  const inheritedPath = options.env ? envValue(options.env, "PATH", true) : undefined;
  if (inheritedPath) assignments.unshift(`set "PATH=${inheritedPath}"`);
  if (options.experimental) assignments.push(`set "PEW2_EXPERIMENTAL=1"`);
  if (options.env?.PEW2_HOME) assignments.push(`set "PEW2_HOME=${options.env.PEW2_HOME}"`);
  if (options.env?.PEW2_RELAY) assignments.push(`set "PEW2_RELAY=${options.env.PEW2_RELAY}"`);
  // Without this the service browses only the home directory, and a user whose
  // code lives on another volume — the whole reason the variable exists — finds
  // nothing to start a session in.
  if (options.env?.PEW2_BROWSE_ROOTS)
    assignments.push(`set "PEW2_BROWSE_ROOTS=${options.env.PEW2_BROWSE_ROOTS}"`);
  // The same for pictures: a folder allowed for images (renders, screenshots)
  // outside the project would otherwise be forgotten by every re-install.
  if (options.env?.PEW2_IMAGE_ROOTS)
    assignments.push(`set "PEW2_IMAGE_ROOTS=${options.env.PEW2_IMAGE_ROOTS}"`);

  const start = program.map(quoteArgument).join(" ");
  const line =
    `${assignments.join(" && ")} && ${start} ` +
    `>> ${quoteArgument(join(logs, "daemon.log"))} ` +
    `2>> ${quoteArgument(join(logs, "daemon.error.log"))}`;

  // UTF-16LE is what `schtasks /create /xml` expects, and the declaration must
  // agree with the BOM and encoding used by `installScheduledTask` below.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pew2 daemon — remote control for desktop coding agents</Description>
    <URI>\\${escapeXml(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
      <!-- Retried for ever, so the daemon comes back after it exits to update.
           Duration must exceed Interval or Windows rejects the definition. -->
      <Repetition>
        <Interval>PT1M</Interval>
        <Duration>P3650D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
    <!-- The logon trigger alone leaves the keepalive unarmed for this whole
         session: a logon has already happened by the time anyone runs
         pew2 setup, so it never fires again and NextRunTime stays empty.
         A daemon that then died at midday stayed dead until the machine was
         logged into again. This starts the same repetition from a boundary
         already in the past, so the clock is running the moment the task
         exists; StartWhenAvailable is what picks up a boundary that has
         been and gone. IgnoreNew makes the extra trigger free - while the
         daemon is up, every repeat of both triggers is discarded. -->
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT1M</Interval>
        <Duration>P3650D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <!-- The keepalive: while the daemon runs, every retry above is ignored. -->
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <!-- A laptop on battery is the normal case for this, not an exception. -->
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <!-- Idle is not a reason to stop a daemon. StopOnIdleEnd defaults to true,
         which terminates the task as soon as the machine stops being idle; and
         RunOnlyIfIdle would stop it starting at all on a machine in use. -->
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <!-- schtasks /run right after install starts the daemon now rather than at
         the next logon, which needs this. -->
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <!-- Waking a sleeping laptop to run a daemon would drain it for nothing;
         the logon trigger picks it up when the machine is next in use. -->
    <WakeToRun>false</WakeToRun>
    <!-- Without this the task is killed after three days by default. -->
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c ${escapeXml(line)}</Arguments>
      <!-- Otherwise the task starts in C:\WINDOWS\system32, and an agent that
           treats its cwd as a project root tries to write there. -->
      <WorkingDirectory>${escapeXml(options.home ?? homedir())}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export interface SchtasksDeps {
  runCommand: (command: string, args: string[]) => Promise<CommandResult>;
  home?: string;
  /** Injected so tests do not spend the startup poll in real time. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function installScheduledTask(
  options: InstallOptions,
  deps: SchtasksDeps,
): Promise<ServiceStatus> {
  const home = options.home ?? deps.home ?? homedir();
  const path = taskXmlPath(home);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(logDir(options.env), { recursive: true });
  // A UTF-16LE BOM, because schtasks rejects UTF-8 XML with a bare
  // "The task XML is malformed" even when it carries a Unicode BOM.
  await writeFile(path, `\ufeff${buildTaskXml(options)}`, "utf16le");

  // `/f` overwrites an existing registration, so re-running install picks up a
  // changed definition instead of failing on a name clash.
  const created = await deps.runCommand("schtasks", [
    "/create",
    "/tn",
    TASK_NAME,
    "/xml",
    path,
    "/f",
  ]);
  if (created.code !== 0) {
    return {
      state: "installed",
      servicePath: path,
      detail: `Written, but schtasks /create failed: ${created.stdout.trim() || `exit ${created.code}`}`,
    };
  }

  // A logon trigger does not fire until the next logon, so the first run is
  // started by hand — otherwise `pew2 setup` reports success on a daemon that
  // will not exist until the user signs out and back in.
  await deps.runCommand("schtasks", ["/run", "/tn", TASK_NAME]);

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < 15; i++) {
    const status = await scheduledTaskStatus(home, deps);
    if (status.state === "running") return status;
    await sleep(200);
  }
  return scheduledTaskStatus(home, deps);
}

export async function uninstallScheduledTask(
  home: string,
  deps: SchtasksDeps,
): Promise<ServiceStatus> {
  const path = taskXmlPath(home);
  await deps.runCommand("schtasks", ["/end", "/tn", TASK_NAME]);
  await deps.runCommand("schtasks", ["/delete", "/tn", TASK_NAME, "/f"]);
  await rm(path, { force: true });
  return { state: "not-installed", servicePath: path };
}

export async function scheduledTaskStatus(
  home: string,
  deps: SchtasksDeps,
): Promise<ServiceStatus> {
  const path = taskXmlPath(home);
  const logPath = join(logDir(), "daemon.log");

  try {
    await readFile(path, "utf8");
  } catch {
    return { state: "not-installed", servicePath: path, logPath };
  }

  const queried = await deps.runCommand("schtasks", ["/query", "/tn", TASK_NAME, "/fo", "LIST"]);
  if (queried.code !== 0) {
    return { state: "installed", servicePath: path, logPath, detail: "Registered but not loaded." };
  }

  // `Status: Running` is Task Scheduler's word for "an instance is executing".
  // Matched loosely because the label is localised on a non-English Windows,
  // where falling back to "installed" is the safe answer rather than a wrong one.
  const running = /^Status:\s*Running\s*$/im.test(queried.stdout);
  const lastResult = queried.stdout.match(/^Last Result:\s*(-?\d+)\s*$/im)?.[1];

  return {
    state: running ? "running" : "installed",
    servicePath: path,
    logPath,
    lastExitCode: lastResult ? Number(lastResult) : undefined,
  };
}
