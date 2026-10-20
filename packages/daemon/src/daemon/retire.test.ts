/**
 * A parked agent process that a call is still using is closed only once that
 * call is done. Closing it at once (a refresh parking a new spare in the same
 * slot) killed goal calls with SIGTERM and the capability probe mid-listing.
 */
import { expect, test } from "bun:test";
import type { AcpSessionHandle } from "../acp/connect.js";
import { Daemon } from "../index.js";

function fakeHandle() {
  const handle = { closed: 0, close() { handle.closed += 1; } };
  return handle;
}

type Retiring = {
  retire(handle: AcpSessionHandle): void;
  onBorrowed<T>(handle: AcpSessionHandle, call: (handle: AcpSessionHandle) => Promise<T>): Promise<T>;
};

test("a spare nobody is using closes at once", () => {
  const daemon = new Daemon({ id: "test", name: "test" }) as unknown as Retiring;
  const handle = fakeHandle();
  daemon.retire(handle as unknown as AcpSessionHandle);
  expect(handle.closed).toBe(1);
});

test("a spare a call is still using closes when the call settles, once", async () => {
  const daemon = new Daemon({ id: "test", name: "test" }) as unknown as Retiring;
  const handle = fakeHandle();
  let finish!: () => void;
  const call = daemon.onBorrowed(handle as unknown as AcpSessionHandle, () => new Promise<string>((resolve) => {
    finish = () => resolve("goals");
  }));
  daemon.retire(handle as unknown as AcpSessionHandle);
  expect(handle.closed).toBe(0);
  finish();
  expect(await call).toBe("goals");
  expect(handle.closed).toBe(1);
});

test("a borrowed spare that is never retired stays open after the call", async () => {
  const daemon = new Daemon({ id: "test", name: "test" }) as unknown as Retiring;
  const handle = fakeHandle();
  await daemon.onBorrowed(handle as unknown as AcpSessionHandle, async () => "ok");
  expect(handle.closed).toBe(0);
});
