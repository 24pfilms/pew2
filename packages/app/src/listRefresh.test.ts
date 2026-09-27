import { expect, test } from "bun:test";
import { ListRefresh } from "./listRefresh";

test("with no project chosen, the re-probe's answer ends the refresh", () => {
  const refresh = new ListRefresh();

  expect(refresh.start("ggcoder", undefined)).toBe(true);
  expect(refresh.answered({ t: "provider.capabilities", providerId: "ggcoder" })).toEqual({
    kind: "done",
  });
  expect(refresh.active).toBe(false);
});

test("with a project chosen, its conversations are asked for only after the re-probe", () => {
  // The daemon answers a project's conversations from the list the probe
  // reads. Asked beside the re-probe, the answer would be the stale list the
  // pull was meant to replace.
  const refresh = new ListRefresh();
  refresh.start("ggcoder", "L:\\code\\api");

  expect(refresh.answered({ t: "provider.sessions", providerId: "ggcoder" })).toEqual({
    kind: "none",
  });
  expect(refresh.answered({ t: "provider.capabilities", providerId: "ggcoder" })).toEqual({
    kind: "sessions",
    providerId: "ggcoder",
    cwd: "L:\\code\\api",
  });
  expect(refresh.active).toBe(true);
  expect(refresh.answered({ t: "provider.sessions", providerId: "ggcoder" })).toEqual({
    kind: "done",
  });
  expect(refresh.active).toBe(false);
});

test("another agent's answer does not end this refresh", () => {
  // Every agent is probed on connect and pushes its own answers; one landing
  // mid-pull is not the one being waited on.
  const refresh = new ListRefresh();
  refresh.start("ggcoder", undefined);

  expect(refresh.answered({ t: "provider.capabilities", providerId: "codex" })).toEqual({
    kind: "none",
  });
  expect(refresh.active).toBe(true);
});

test("a second pull while one is running is refused", () => {
  // Each pull boots the agent on the computer.
  const refresh = new ListRefresh();

  expect(refresh.start("ggcoder", undefined)).toBe(true);
  expect(refresh.start("ggcoder", undefined)).toBe(false);
  expect(refresh.start("codex", undefined)).toBe(false);
});

test("a cancelled refresh ignores late answers and allows the next pull", () => {
  const refresh = new ListRefresh();
  refresh.start("ggcoder", "/work/api");
  refresh.cancel();

  expect(refresh.answered({ t: "provider.capabilities", providerId: "ggcoder" })).toEqual({
    kind: "none",
  });
  expect(refresh.start("ggcoder", "/work/api")).toBe(true);
});
