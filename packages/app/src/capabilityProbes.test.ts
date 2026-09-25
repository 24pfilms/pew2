import { expect, test } from "bun:test";
import { CapabilityProbes } from "./capabilityProbes";

const announced = [
  { id: "ggcoder", available: true },
  { id: "claude-code", available: true },
];

test("every available agent is asked once, not once per announcement", () => {
  const probes = new CapabilityProbes();

  expect(probes.take(announced)).toEqual(["ggcoder", "claude-code"]);
  // The daemon re-announces on every reconnect; that alone is not a reason to
  // probe each agent again.
  expect(probes.take(announced)).toEqual([]);
});

test("an agent that cannot run here is never asked", () => {
  const probes = new CapabilityProbes();

  expect(
    probes.take([
      { id: "ggcoder", available: true },
      { id: "gemini-cli", available: false },
      // An older daemon announced no availability at all, which is not a
      // promise that the agent works.
      { id: "codex" },
    ]),
  ).toEqual(["ggcoder"]);
});

test("a dropped socket makes every agent askable again", () => {
  // The bug this class exists for. The guard was filled at launch and never
  // cleared, so a project created at the desk stayed invisible on the phone
  // until the app was force-quit — the daemon had it, nothing asked for it.
  const probes = new CapabilityProbes();
  probes.take(announced);

  probes.disconnected();

  expect(probes.take(announced)).toEqual(["ggcoder", "claude-code"]);
});

test("reconnecting repeatedly re-asks every time, since each is a new connection", () => {
  const probes = new CapabilityProbes();

  for (let i = 0; i < 3; i++) {
    probes.disconnected();
    expect(probes.take(announced)).toEqual(["ggcoder", "claude-code"]);
  }
});

test("an agent that appears only after reconnecting is still asked", () => {
  // Installing an agent at the desk announces a provider this connection has
  // never seen; it must not be held back by the ones that were.
  const probes = new CapabilityProbes();
  probes.take([{ id: "ggcoder", available: true }]);

  expect(probes.take(announced)).toEqual(["claude-code"]);
});

test("an agent that becomes available later is asked then, not skipped for ever", () => {
  const probes = new CapabilityProbes();
  probes.take([{ id: "gemini-cli", available: false }]);

  expect(probes.take([{ id: "gemini-cli", available: true }])).toEqual(["gemini-cli"]);
});
