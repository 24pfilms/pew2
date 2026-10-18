/**
 * "Call me when it's done" has to ring even when the moment it is done is a
 * moment the phone cannot hear: the relay down for a minute, or a job that dies
 * without ever ending. These pin that the call is held, resent and confirmed.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { wire } from "@pew2/protocol";
import { CallbackLedger, type JobState } from "./callbacks.js";

const WHO = { providerId: "ggcoder", folder: "Voiceprompter", agentName: "OrcaCoder" };

function ledger(options: { path?: string } = {}) {
  let now = 1_000_000;
  const sent: wire.CallbackDue[] = [];
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), "pew2-callbacks-")), "callbacks.json");
  const book = new CallbackLedger({ path, send: (m) => sent.push(m), now: () => now, log: () => {} });
  return {
    book,
    sent,
    path,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const working = (lastActivityAt?: number): (() => JobState) => () => ({ working: true, lastActivityAt });

test("a finished job becomes one call, worded from what the agent said this turn", () => {
  const { book, sent } = ledger();
  const id = book.promise("s1", { ...WHO, lastText: "words from the turn before" });

  expect(book.settle("s1", { ok: true }, { ...WHO, lastText: "Launcher tested: all good." })).toBe(id);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    t: "callback.due",
    id,
    sessionId: "s1",
    outcome: "done",
    title: "Voiceprompter · OrcaCoder",
    body: "Launcher tested: all good.",
  });
  // Kept once: a second idle for the same conversation owes nothing.
  expect(book.settle("s1", { ok: true }, WHO)).toBeUndefined();
});

test("the previous turn's last words are never quoted for this job", () => {
  const { book, sent } = ledger();
  book.promise("s1", { ...WHO, lastText: "words from the turn before" });
  book.settle("s1", { ok: true }, WHO);
  expect(sent[0]?.body).toBe("Finished and waiting on you.");
});

test("a job that ends in an error is called about as stopped, with the reason", () => {
  const { book, sent } = ledger();
  book.promise("s1", WHO);
  book.settle("s1", { ok: false, error: "ACP connection closed." }, WHO);
  expect(sent[0]).toMatchObject({ outcome: "failed", title: "Voiceprompter · OrcaCoder stopped" });
  expect(sent[0]?.body).toContain("ACP connection closed");
});

test("a turn nobody asked to be called about owes nothing", () => {
  const { book, sent } = ledger();
  expect(book.settle("s1", { ok: true }, WHO)).toBeUndefined();
  expect(sent).toEqual([]);
});

test("a call lost while the link was down is resent until the phone confirms it", () => {
  const { book, sent, advance } = ledger();
  book.promise("s1", WHO);
  book.settle("s1", { ok: true }, WHO); // the first send: into a dead relay

  advance(CallbackLedger.RESEND_MS - 1);
  book.tick(working());
  expect(sent).toHaveLength(1);

  advance(1);
  book.tick(working());
  expect(sent).toHaveLength(2);
  expect(sent[1]?.id).toBe(sent[0]?.id);

  book.ack(sent[0]!.id);
  advance(CallbackLedger.RESEND_MS * 5);
  book.tick(working());
  expect(sent).toHaveLength(2);
  expect(book.snapshot().due).toEqual([]);
});

test("a phone saying hello is handed every call still owed", () => {
  const { book } = ledger();
  book.promise("s1", WHO);
  book.settle("s1", { ok: true }, WHO);
  expect(book.pending().map((call) => call.sessionId)).toEqual(["s1"]);
});

test("a job silent for too long gets one 'may be stuck' call, and still rings when it ends", () => {
  const { book, sent, advance } = ledger();
  const id = book.promise("s1", WHO);

  advance(CallbackLedger.STALL_MS - 1);
  book.tick(working());
  expect(sent).toEqual([]);

  advance(1);
  book.tick(working());
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ id: `${id}_stalled`, outcome: "stalled" });
  expect(sent[0]?.body).toContain("20 minutes");

  advance(CallbackLedger.STALL_MS * 3);
  book.ack(sent[0]!.id);
  book.tick(working());
  expect(sent).toHaveLength(1);

  book.settle("s1", { ok: true }, WHO);
  expect(sent.at(-1)).toMatchObject({ id, outcome: "done" });
});

test("recent activity holds the stuck call off", () => {
  const { book, sent, advance } = ledger();
  book.promise("s1", WHO);
  advance(CallbackLedger.STALL_MS + 5_000);
  book.tick(working(1_000_000 + CallbackLedger.STALL_MS));
  expect(sent).toEqual([]);
});

test("a job whose conversation is gone is called about as stopped, and the promise ends", () => {
  const { book, sent, advance } = ledger();
  const id = book.promise("s1", WHO);
  advance(CallbackLedger.STALL_MS);
  book.tick(() => undefined);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ id, outcome: "failed" });
  expect(book.snapshot().waiting).toEqual([]);
});

test("a call never confirmed is dropped after twelve hours", () => {
  const { book, sent, advance } = ledger();
  book.promise("s1", WHO);
  book.settle("s1", { ok: true }, WHO);
  advance(CallbackLedger.EXPIRE_MS + 1);
  book.tick(working());
  expect(book.snapshot().due).toEqual([]);
  expect(sent).toHaveLength(1);
});

test("a restart carries owed calls over, and reports a job that was mid-run as maybe stopped", async () => {
  const first = ledger();
  await first.book.load();
  first.book.promise("s1", WHO);
  first.book.promise("s2", { ...WHO, folder: "pew2" });
  first.book.settle("s2", { ok: true }, WHO);
  await first.book.flush();

  const second = ledger({ path: first.path });
  await second.book.load();
  const owed = second.book.pending();
  expect(owed.map((call) => [call.sessionId, call.outcome]).sort()).toEqual([
    ["s1", "failed"],
    ["s2", "done"],
  ]);
  expect(owed.find((call) => call.sessionId === "s1")?.body).toContain("pew2 restarted");
  expect(second.book.snapshot().waiting).toEqual([]);
});

test("a ledger that never loaded never writes, so a test cannot touch the live file", async () => {
  const { book, path } = ledger();
  book.promise("s1", WHO);
  book.settle("s1", { ok: true }, WHO);
  await book.flush();
  expect(existsSync(path)).toBe(false);
});

test("a corrupt file is reported and replaced, never fatal", async () => {
  const { book, path } = ledger();
  writeFileSync(path, "{not json");
  await book.load();
  book.promise("s1", WHO);
  await book.flush();
  expect(JSON.parse(readFileSync(path, "utf8")).waiting).toHaveLength(1);
});
