import { expect, test } from "bun:test";
import {
  BROKEN_CHANNEL_FRAMES,
  ConnectionWatch,
  HANDSHAKE_TIMEOUT,
  PING_INTERVAL,
  PONG_TIMEOUT,
  PROBE_TIMEOUT,
  type ReconnectReason,
} from "./connectionWatch";

/** A clock the test moves by hand, so every deadline is exact. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      set(callback: () => void, ms: number) {
        const id = next++;
        pending.set(id, { at: now + ms, callback });
        return id;
      },
      clear(handle: unknown) {
        pending.delete(handle as number);
      },
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function watch() {
  const clock = fakeTimers();
  const reasons: ReconnectReason[] = [];
  let pings = 0;
  let proven = 0;
  const subject = new ConnectionWatch({
    sendPing: () => {
      pings += 1;
    },
    reconnect: (reason) => reasons.push(reason),
    onProven: () => {
      proven += 1;
    },
    timers: clock.timers,
  });
  return {
    clock,
    subject,
    reasons,
    get pings() {
      return pings;
    },
    get proven() {
      return proven;
    },
  };
}

test("an open socket that never proves itself is replaced, not called online", () => {
  // The relay accepts the socket before the daemon has seen this phone. A proof
  // the daemon refuses is refused in silence, so without a deadline the app
  // announced "online" for a channel that never carried a frame.
  const w = watch();
  w.subject.heard(); // the relay's cleartext `ready` proves nothing
  w.clock.advance(HANDSHAKE_TIMEOUT - 1);
  expect(w.reasons).toEqual([]);
  w.clock.advance(1);
  expect(w.reasons).toEqual(["handshake-timeout"]);
  expect(w.proven).toBe(0);
});

test("the first sealed frame proves the channel, once", () => {
  const w = watch();
  w.subject.sealed();
  w.subject.sealed();
  expect(w.proven).toBe(1);
  expect(w.subject.isProven).toBe(true);
  w.clock.advance(HANDSHAKE_TIMEOUT * 3);
  expect(w.reasons).not.toContain("handshake-timeout");
});

test("a proven connection pings on schedule and survives while answered", () => {
  const w = watch();
  w.subject.sealed();
  for (let round = 1; round <= 3; round++) {
    w.clock.advance(PING_INTERVAL);
    expect(w.pings).toBe(round);
    w.subject.heard(); // the relay's pong
  }
  expect(w.reasons).toEqual([]);
});

test("a ping that goes unanswered replaces the socket", () => {
  // A network switch or Doze leaves the socket half open with readyState still
  // OPEN; the operating system can take minutes to notice. Nothing pinged, so
  // nothing noticed.
  const w = watch();
  w.subject.sealed();
  w.clock.advance(PING_INTERVAL);
  expect(w.pings).toBe(1);
  w.clock.advance(PONG_TIMEOUT - 1);
  expect(w.reasons).toEqual([]);
  w.clock.advance(1);
  expect(w.reasons).toEqual(["no-pong"]);
});

test("any frame counts as an answer, not only the pong", () => {
  // A daemon streaming a long reply is plainly alive; replacing its socket
  // because the pong queued behind those frames would interrupt the very thing
  // the user is watching.
  const w = watch();
  w.subject.sealed();
  w.clock.advance(PING_INTERVAL);
  w.subject.sealed();
  w.clock.advance(PONG_TIMEOUT * 2);
  expect(w.reasons).toEqual([]);
});

test("a second ping does not extend a deadline already running", () => {
  const w = watch();
  w.subject.sealed();
  w.clock.advance(PING_INTERVAL); // ping 1, deadline at +PONG_TIMEOUT
  w.clock.advance(PONG_TIMEOUT - 1000);
  w.subject.probe(); // ping 2 must not buy more time
  w.clock.advance(1000);
  expect(w.reasons).toEqual(["no-pong"]);
});

test("coming back to the screen checks the socket with a short deadline", () => {
  // The likeliest moment for a zombie socket is right after the phone has been
  // in a pocket, and it is exactly when someone is looking at the status.
  const w = watch();
  w.subject.sealed();
  w.subject.probe();
  expect(w.pings).toBe(1);
  w.clock.advance(PROBE_TIMEOUT);
  expect(w.reasons).toEqual(["no-pong"]);
});

test("a probe before the channel is proven leaves the handshake deadline in charge", () => {
  const w = watch();
  w.subject.probe();
  expect(w.pings).toBe(0);
  w.clock.advance(PROBE_TIMEOUT);
  expect(w.reasons).toEqual([]);
});

test("a genuine daemon hello replaces the socket at once", () => {
  // A daemon that reconnects to the relay builds a fresh channel that has never
  // seen this phone: its frames are rejected here as replays, and ours are
  // dropped there. The socket is fine; the channel is dead both ways.
  const w = watch();
  w.subject.sealed();
  w.subject.daemonHello(true);
  expect(w.reasons).toEqual(["daemon-rejoined"]);
});

test("a hello that fails its proof is ignored", () => {
  // Anyone who learns the room id can send cleartext. Only the paired machine
  // can make this phone reconnect.
  const w = watch();
  w.subject.sealed();
  w.subject.daemonHello(false);
  expect(w.reasons).toEqual([]);
});

test("sealed frames that keep failing to open break the channel", () => {
  // The backstop for a daemon hello that never arrived: a channel the far side
  // is no longer speaking shows up as frames that will not open.
  const w = watch();
  w.subject.sealed();
  for (let i = 1; i < BROKEN_CHANNEL_FRAMES; i++) w.subject.rejected();
  expect(w.reasons).toEqual([]);
  w.subject.rejected();
  expect(w.reasons).toEqual(["channel-broken"]);
});

test("one good frame between failures resets the count", () => {
  const w = watch();
  w.subject.sealed();
  for (let i = 1; i < BROKEN_CHANNEL_FRAMES; i++) w.subject.rejected();
  w.subject.sealed();
  for (let i = 1; i < BROKEN_CHANNEL_FRAMES; i++) w.subject.rejected();
  expect(w.reasons).toEqual([]);
});

test("a network change replaces the socket without testing it first", () => {
  // A socket bound to the network the phone just left is dead, and a probe
  // would only spend its deadline proving it.
  const w = watch();
  w.subject.sealed();
  w.subject.networkChanged();
  expect(w.reasons).toEqual(["network-changed"]);
});

test("reconnect is asked for once, and every timer stops with it", () => {
  const w = watch();
  w.subject.sealed();
  w.subject.daemonHello(true);
  w.subject.networkChanged();
  w.subject.rejected();
  w.clock.advance(PING_INTERVAL * 5);
  expect(w.reasons).toEqual(["daemon-rejoined"]);
  expect(w.pings).toBe(0);
  expect(w.clock.pendingCount).toBe(0);
});

test("stop leaves nothing scheduled", () => {
  const w = watch();
  w.subject.sealed();
  w.clock.advance(PING_INTERVAL); // a pong deadline is now running too
  w.subject.stop();
  expect(w.clock.pendingCount).toBe(0);
  w.clock.advance(HANDSHAKE_TIMEOUT * 10);
  expect(w.reasons).toEqual([]);
});

test("a daemon that reconnects is unreadable on the old channel, and its hello proves it", async () => {
  // The bug this module exists for, with the real cipher. A daemon reconnecting
  // to the relay builds a new channel whose counters restart at zero; the
  // phone's channel has already seen higher ones and rejects every frame as a
  // replay. The cleartext hello that announces the new channel is the signal,
  // and it is only acted on when its proof opens under the pairing key.
  const { SecureChannel, e2e } = await import("@pew2/protocol");
  const { isGenuineDaemonHello } = await import("./connectionWatch");
  const key = e2e.randomRootKey();
  const phone = new SecureChannel(key, "app");

  const before = new SecureChannel(key, "daemon");
  for (let i = 0; i < 5; i++) {
    expect(phone.open(before.seal({ t: "providers", i }))).toBeDefined();
  }

  const after = new SecureChannel(key, "daemon");
  expect(phone.open(after.seal({ t: "providers" }))).toBeUndefined();

  const hello = { t: "hello", role: "daemon", deviceId: "studio", proof: after.proof("studio") };
  expect(isGenuineDaemonHello(phone, hello)).toBe(true);

  const forged = new SecureChannel(e2e.randomRootKey(), "daemon");
  const fake = { t: "hello", role: "daemon", deviceId: "studio", proof: forged.proof("studio") };
  expect(isGenuineDaemonHello(new SecureChannel(key, "app"), fake)).toBe(false);
  expect(isGenuineDaemonHello(phone, { t: "hello", role: "app", deviceId: "studio" })).toBe(false);

  // The cure: a fresh channel, which is what a new socket brings.
  const reconnected = new SecureChannel(key, "app");
  expect(reconnected.open(after.seal({ t: "providers" }))).toBeDefined();
});
