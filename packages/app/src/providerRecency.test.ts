import { expect, test } from "bun:test";
import { orderProvidersByRecency } from "./providerRecency";

const provider = (id: string, available = true) => ({ id, available });
const session = (providerId: string, startedAt: number) => ({ providerId, startedAt });

test("the most recently used app leads the row", () => {
  const ordered = orderProvidersByRecency(
    [provider("claude-code"), provider("opencode"), provider("codex")],
    [session("opencode", 200), session("claude-code", 100)],
  );

  expect(ordered.map((p) => p.id)).toEqual(["opencode", "claude-code", "codex"]);
});

test("unused apps keep their original order after the used ones", () => {
  const ordered = orderProvidersByRecency(
    [provider("codex"), provider("gemini-cli"), provider("opencode")],
    [session("opencode", 100)],
  );

  expect(ordered.map((p) => p.id)).toEqual(["opencode", "codex", "gemini-cli"]);
});

test("an unavailable app trails even with the freshest history", () => {
  const ordered = orderProvidersByRecency(
    [provider("codex", false), provider("claude-code")],
    [session("codex", 999), session("claude-code", 1)],
  );

  expect(ordered.map((p) => p.id)).toEqual(["claude-code", "codex"]);
});

test("recency uses the newest session, not the first listed", () => {
  const ordered = orderProvidersByRecency(
    [provider("a"), provider("b")],
    [session("a", 50), session("b", 10), session("a", 5), session("b", 500)],
  );

  expect(ordered.map((p) => p.id)).toEqual(["b", "a"]);
});

test("no sessions at all preserves the original row", () => {
  const input = [provider("a"), provider("b"), provider("c")];
  expect(orderProvidersByRecency(input, []).map((p) => p.id)).toEqual(["a", "b", "c"]);
});

test("GG Coder and GG Goals always lead, in that order, whatever was used last", () => {
  const providers = [
    { id: "claude-code", available: true },
    { id: "gg-goals", available: true },
    { id: "opencode", available: true },
    { id: "ggcoder", available: false },
  ];
  const sessions = [
    { providerId: "opencode", startedAt: 300 },
    { providerId: "claude-code", startedAt: 200 },
  ];
  expect(orderProvidersByRecency(providers, sessions).map((p) => p.id)).toEqual([
    "ggcoder",
    "gg-goals",
    "opencode",
    "claude-code",
  ]);
  // Missing pinned agents leave no gap.
  expect(orderProvidersByRecency(providers.filter((p) => p.id !== "ggcoder"), sessions).map((p) => p.id)).toEqual([
    "gg-goals",
    "opencode",
    "claude-code",
  ]);
});
