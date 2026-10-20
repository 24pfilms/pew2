import { describe, expect, test } from "bun:test";
import {
  matchProjects,
  projectChips,
  projectLabel,
  projectsForProvider,
  projectSourceKey,
  sessionsInProject,
  sessionsInStudioProject,
} from "./projects";
import type { Session } from "./useDaemon";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    providerId: "claude-code",
    title: "A conversation",
    startedAt: 0,
    turns: [],
    configOptions: [],
    ...partial,
  };
}

test("the daemon's list is used as announced, newest project first", () => {
  const projects = projectsForProvider(
    [
      { path: "/a/site", name: "site", sessions: 2, updatedAt: "2026-07-01T00:00:00Z" },
      { path: "/a/pew2", name: "pew2", sessions: 9, updatedAt: "2026-08-01T00:00:00Z" },
    ],
    [],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["pew2", "site"]);
  expect(projects[0]!.sessions).toBe(9);
});

test("a project seen only in the sessions on screen is still offered", () => {
  const projects = projectsForProvider(
    [],
    [session({ id: "1", cwd: "/a/fresh" })],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["fresh"]);
});

test("a project used a minute ago sorts above the agent's dated ones", () => {
  // It has no announced stamp of its own, and undated would put the most
  // recent work last in a menu that promises newest first.
  const projects = projectsForProvider(
    [{ path: "/a/old", name: "old", updatedAt: "2020-01-01T00:00:00Z" }],
    [session({ id: "1", cwd: "/a/fresh", startedAt: Date.now() })],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["fresh", "old"]);
});

test("another agent's projects are never offered under this one", () => {
  const projects = projectsForProvider(
    [],
    [session({ id: "1", cwd: "/a/other", providerId: "codex" })],
    "claude-code",
  );

  expect(projects).toEqual([]);
});

test("a project in both sources is listed once, keeping the daemon's count", () => {
  const projects = projectsForProvider(
    [{ path: "/a/pew2", name: "pew2", sessions: 12 }],
    [session({ id: "1", cwd: "/a/pew2" })],
    "claude-code",
  );

  expect(projects).toHaveLength(1);
  expect(projects[0]!.sessions).toBe(12);
});

test("choosing a project keeps only its conversations", () => {
  const sessions = [
    session({ id: "1", cwd: "/a/pew2" }),
    session({ id: "2", cwd: "/a/site" }),
  ];

  const kept = sessionsInProject(sessions, { path: "/a/pew2", name: "pew2" });
  expect(kept.map((s) => s.id)).toEqual(["1"]);
});

test("a conversation started on this phone matches by the folder the daemon stamped", () => {
  // It never had a `cwd` of its own; without this fallback it would vanish out
  // of the very project it was started in.
  const local = session({ id: "1", folder: "pew2" });

  expect(sessionsInProject([local], { path: "/a/pew2", name: "pew2" })).toHaveLength(1);
  expect(sessionsInProject([local], { path: "/a/site", name: "site" })).toHaveLength(0);
});

test("a session with neither path nor folder is not claimed by a project", () => {
  expect(sessionsInProject([session({ id: "1" })], { path: "/a/pew2", name: "pew2" })).toEqual([]);
});

test("no choice shows everything", () => {
  const sessions = [session({ id: "1", cwd: "/a/pew2" }), session({ id: "2" })];
  expect(sessionsInProject(sessions, undefined)).toHaveLength(2);
});

test("the control always has a label", () => {
  expect(projectLabel(undefined)).toBe("All projects");
  expect(projectLabel({ path: "/a/pew2", name: "pew2" })).toBe("pew2");
});

test("the memo key ignores a streamed chunk landing on a session's turns", () => {
  // The exact case this exists for: a chunk arrives, the sessions array is
  // rebuilt with new turns on the active session, and the project list is
  // unaffected. A changed key here would put the sort back on every chunk.
  const before = [session({ id: "1", cwd: "/a/pew2" })];
  const after = [session({ id: "1", cwd: "/a/pew2", turns: [{ id: "t1" }] as never })];

  expect(projectSourceKey(after, "claude-code")).toBe(projectSourceKey(before, "claude-code"));
});

test("the memo key changes when a session introduces a new project", () => {
  const before = [session({ id: "1", cwd: "/a/pew2" })];
  const after = [...before, session({ id: "2", cwd: "/a/site" })];

  expect(projectSourceKey(after, "claude-code")).not.toBe(
    projectSourceKey(before, "claude-code"),
  );
});

test("the memo key is scoped to one agent", () => {
  // Another agent's conversations cannot change this agent's project list, so
  // they must not invalidate it either.
  const sessions = [
    session({ id: "1", cwd: "/a/pew2" }),
    session({ id: "2", cwd: "/a/site", providerId: "codex" }),
  ];

  expect(projectSourceKey(sessions, "claude-code")).toBe(
    projectSourceKey([sessions[0]!], "claude-code"),
  );
});

test("the memo key separates fields so neighbouring values cannot merge", () => {
  // Without a separator, {cwd:"/a", startedAt:11} and {cwd:"/a1", startedAt:1}
  // would produce the same key and one would be silently skipped.
  const a = [session({ id: "1", cwd: "/a", startedAt: 11 })];
  const b = [session({ id: "1", cwd: "/a1", startedAt: 1 })];

  expect(projectSourceKey(a, "claude-code")).not.toBe(projectSourceKey(b, "claude-code"));
});

describe("matchProjects", () => {
  const projects = [
    { path: "/p/web", name: "website" },
    { path: "/p/fix", name: "OrcaWork Fix" },
    { path: "/p/vp", name: "Voiceprompter" },
    { path: "/p/orca", name: "orcacoder-v5" },
  ];

  test("names that start with it first, then names that contain it, newest first within each", () => {
    expect(matchProjects(projects, "orca").map((p) => p.name)).toEqual(["OrcaWork Fix", "orcacoder-v5"]);
    expect(matchProjects(projects, "prompt").map((p) => p.name)).toEqual(["Voiceprompter"]);
    expect(matchProjects(projects, "e").map((p) => p.name)).toEqual(["website", "Voiceprompter", "orcacoder-v5"]);
  });

  test("case, spaces, dashes and underscores do not matter", () => {
    expect(matchProjects(projects, "ORCA WORK").map((p) => p.name)).toEqual(["OrcaWork Fix"]);
    expect(matchProjects(projects, "coder v5").map((p) => p.name)).toEqual(["orcacoder-v5"]);
  });

  test("an empty search is every project; no match is an empty list", () => {
    expect(matchProjects(projects, "  ")).toHaveLength(4);
    expect(matchProjects(projects, "zzz")).toEqual([]);
  });
});

describe("sessionsInStudioProject", () => {
  const chats = [
    { id: "a", topics: ["EverestChris_Components", "atlas-samples"] },
    { id: "b", topics: ["internet-message-globe-v2"] },
    { id: "c" },
  ];

  test("only the chats that worked in that studio project, by exact name", () => {
    expect(sessionsInStudioProject(chats, "atlas-samples").map((c) => c.id)).toEqual(["a"]);
    // "internet-message-globe" is not "internet-message-globe-v2".
    expect(sessionsInStudioProject(chats, "internet-message-globe")).toEqual([]);
  });

  test("no studio project picked: every chat", () => {
    expect(sessionsInStudioProject(chats, undefined)).toHaveLength(3);
  });
});

describe("projectChips", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ path: `/p/${i}`, name: `p${i}` }));

  test("the first chip can name what it clears to, as a studio's does", () => {
    const studioAll = { label: "All", a11y: "Every chat in Orcastrator" };
    expect(projectChips(many, undefined, 3, false, studioAll).items[0]).toEqual(studioAll);
  });

  test("folded to one, the row shows the chosen project and counts the rest", () => {
    const { items, hidden } = projectChips(many, "/p/20", 1);
    expect(items.map((item) => item.label)).toEqual(["All", "p20"]);
    expect(hidden).toBe(29);
  });

  test("All first, then one chip per project in order, nothing hidden when they fit", () => {
    const { items, hidden } = projectChips(
      [
        { path: "/a/one", name: "one" },
        { path: "/b/two", name: "two" },
      ],
      undefined,
      9,
    );
    expect(items).toEqual([
      { label: "All", a11y: "All projects" },
      { path: "/a/one", label: "one", a11y: "Project one" },
      { path: "/b/two", label: "two", a11y: "Project two" },
    ]);
    expect(hidden).toBe(0);
  });

  test("the newest up to the limit, and the rest counted behind '+N more'", () => {
    const { items, hidden } = projectChips(many, undefined, 9);
    expect(items.map((item) => item.label)).toEqual(["All", "p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    expect(hidden).toBe(21);
  });

  test("the chosen project is always on show, even when it is an old one", () => {
    const { items, hidden } = projectChips(many, "/p/25", 9);
    expect(items).toHaveLength(10);
    expect(items.at(-1)?.path).toBe("/p/25");
    expect(items.some((item) => item.path === "/p/8")).toBe(false);
    expect(hidden).toBe(21);
  });

  test("expanded shows every project", () => {
    const { items, hidden } = projectChips(many, "/p/25", 9, true);
    expect(items).toHaveLength(31);
    expect(hidden).toBe(0);
  });
});
