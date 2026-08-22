import { expect, test } from "bun:test";
import { folderName, resolveWorkspace } from "./workspace.js";

const env = {} as NodeJS.ProcessEnv;

test("an explicit request always wins", () => {
  expect(resolveWorkspace("/tmp/project", { PEW2_WORKSPACE: "/env" }, "/", "/home/u")).toBe(
    "/tmp/project",
  );
});

test("PEW2_WORKSPACE overrides the daemon cwd", () => {
  expect(resolveWorkspace(undefined, { PEW2_WORKSPACE: "/srv/work" }, "/repo", "/home/u")).toBe(
    "/srv/work",
  );
});

test("a filesystem root falls back to the home directory", () => {
  // The launchd case: cwd is "/", and agents must not treat it as a project.
  expect(resolveWorkspace(undefined, env, "/", "/Users/kenkai")).toBe("/Users/kenkai");
});

test("a missing daemon cwd falls back to the home directory", () => {
  expect(resolveWorkspace(undefined, env, "/gone/since/boot", "/Users/kenkai")).toBe(
    "/Users/kenkai",
  );
});

test("an ordinary daemon cwd is kept", () => {
  expect(resolveWorkspace(undefined, env, process.cwd(), "/home/u")).toBe(process.cwd());
});

test("names a project by its last path segment, for the finished-turn banner", () => {
  expect(folderName("/Users/kenkai/gg-projects/pew2")).toBe("pew2");
  // A trailing slash must not produce an empty name.
  expect(folderName("/Users/kenkai/gg-projects/pew2/")).toBe("pew2");
});

test("no path means no project name, rather than a slash", () => {
  expect(folderName(undefined)).toBeUndefined();
  expect(folderName("/")).toBeUndefined();
});

test("a Windows system directory is not a workspace, however writable it looks", () => {
  // The launchd `mkdir '/.gg'` bug, one platform over. Task Scheduler starts a
  // task in C:\WINDOWS\system32, which is not the filesystem root and does
  // exist — so the root check waved it through, and GG Coder's capability probe
  // died on `EPERM: mkdir 'C:\WINDOWS\system32\.gg'`, taking its session
  // history off the phone with it. Nobody chooses system32 as a project.
  const win = { SystemRoot: "C:\\WINDOWS" };

  expect(resolveWorkspace(undefined, win, "C:\\WINDOWS\\system32", "C:\\Users\\ada")).toBe(
    "C:\\Users\\ada",
  );
  expect(resolveWorkspace(undefined, win, "C:\\WINDOWS", "C:\\Users\\ada")).toBe("C:\\Users\\ada");
});

test("the system directory is matched the way Windows compares paths", () => {
  // Case-insensitively, and under either separator: the variable is
  // conventionally `windir` as often as `SystemRoot`, and neither casing nor a
  // forward slash makes system32 a safe place to write.
  expect(
    resolveWorkspace(undefined, { windir: "C:\\Windows" }, "c:/windows/system32", "C:\\Users\\ada"),
  ).toBe("C:\\Users\\ada");
});

test("a real project that merely sits near the system drive is still honoured", () => {
  // The guard must not swallow anything that merely starts with the same
  // letters, which a plain prefix test would.
  expect(
    resolveWorkspace(undefined, { SystemRoot: "C:\\WINDOWS" }, process.cwd(), "C:\\Users\\ada"),
  ).toBe(process.cwd());
});

test("an explicit request still wins over the system-directory guard", () => {
  // Someone who genuinely asks for a path gets it; this guard is only ever
  // about the cwd nobody chose.
  expect(
    resolveWorkspace("C:\\WINDOWS\\system32", { SystemRoot: "C:\\WINDOWS" }, "/", "C:\\Users\\ada"),
  ).toBe("C:\\WINDOWS\\system32");
});