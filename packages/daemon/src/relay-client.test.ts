/**
 * Relay client tests.
 *
 * The relay is what makes pew2 usable from anywhere, and the failure that
 * matters is not the first connection — it is the thousandth. Desktops sleep,
 * Wi-Fi changes, relays deploy. The user is not at the machine to restart
 * anything, so reconnection is the feature under test here.
 */
import { test, expect } from "bun:test";
import {
  RelayClient,
  backoffBounds,
  describeRefusal,
  probeRefusal,
  type RelayClientOptions,
  type RelayRefusal,
} from "./relay-client.js";
import { SecureChannel, e2e, wire } from "@pew2/protocol";

const { WIRE_VERSION } = wire;
import type { Daemon } from "./index.js";

/** The pairing both ends of these tests share. */
const KEY = "11".repeat(32);

/**
 * Stands in for the phone.
 *
 * Traffic to the daemon is encrypted, so a test that sends bare JSON is testing
 * a path that no longer exists — the client would drop it, correctly, and the
 * test would prove nothing.
 */
function phone() {
  return new SecureChannel(e2e.fromHex(KEY), "app");
}

/** Enough of a Daemon for the client to drive. */
function fakeDaemon({
  refreshFails = false,
  catchUp = (): unknown[] => [],
}: { refreshFails?: boolean; catchUp?: (cursors: Record<string, number>) => unknown[] } = {}) {
  const calls: string[] = [];
  const cursorsSeen: Record<string, number>[] = [];
  return {
    calls,
    cursorsSeen,
    daemon: {
      refreshProviders: async () => {
        calls.push("refreshProviders");
        // Re-scanning providers reads the disk and spawns probe processes, so
        // it can genuinely fail on a machine that just woke up.
        if (refreshFails) throw new Error("EMFILE: too many open files");
        return { providers: [], errors: [] };
      },
      catchUp: (cursors: Record<string, number>) => {
        calls.push("catchUp");
        cursorsSeen.push(cursors);
        return catchUp(cursors);
      },
    } as unknown as Daemon,
  };
}

/** A WebSocket that never really connects, driven by hand. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string> = {},
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Deliver a raw frame, exactly as the relay would. */
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function client(
  overrides: Partial<RelayClientOptions> = {},
  daemonOptions: {
    refreshFails?: boolean;
    catchUp?: (cursors: Record<string, number>) => unknown[];
  } = {},
) {
  FakeSocket.instances = [];
  const { daemon, calls, cursorsSeen } = fakeDaemon(daemonOptions);
  const statuses: string[] = [];
  const relay = new RelayClient({
    daemon,
    url: "wss://relay.example.com",
    token: "t".repeat(48),
    key: "11".repeat(32),
    deviceId: "test-machine",
    onStatus: (status) => statuses.push(status),
    createSocket: (url, headers) => new FakeSocket(url, headers) as unknown as WebSocket,
    ...overrides,
  });
  return { relay, statuses, calls, cursorsSeen };
}

test("dials out with the pairing token, as the daemon role", () => {
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;

  // Dialling *out* is the whole point: no port forwarding, no public address,
  // works from behind any NAT.
  const url = new URL(socket.url);
  expect(url.protocol).toBe("wss:");
  expect(url.pathname).toBe("/connect");
  expect(url.searchParams.get("pairing")).toBe("t".repeat(48));
  expect(url.searchParams.get("role")).toBe("daemon");
  expect(url.searchParams.get("deviceId")).toBe("test-machine");
  relay.stop();
});

test("announces itself and re-announces providers on connect", () => {
  const { relay, statuses, calls } = client();

  relay.start();
  FakeSocket.instances[0]!.open();

  const hello = JSON.parse(FakeSocket.instances[0]!.sent[0]!);
  expect(hello).toMatchObject({ t: "hello", role: "daemon", deviceId: "test-machine" });
  // The phone may have been waiting on the relay long before this machine woke
  // up, so the provider list has to be pushed again rather than assumed sent.
  expect(calls).toContain("refreshProviders");
  expect(statuses).toEqual(["connecting", "online"]);
  relay.stop();
});

test("a failed provider re-announce does not bring down the connection", async () => {
  // `refreshProviders` is fired without being awaited, because the connection
  // is usable before it finishes. That makes an unhandled rejection here fatal
  // to the whole daemon — both Bun and Node exit on one by default — and it
  // would land at the exact moment the user is trying to reconnect, which is
  // the worst possible time to lose the process.
  //
  // The rejection hook is what actually guards this. The status and `online`
  // assertions below would pass with or without the `.catch`, since the
  // rejection happens after `onopen` has already returned.
  const rejections: unknown[] = [];
  const onRejection = (error: unknown) => rejections.push(error);
  process.on("unhandledRejection", onRejection);

  try {
    const { relay, statuses, calls } = client({}, { refreshFails: true });

    relay.start();
    FakeSocket.instances[0]!.open();

    // Let the rejected promise settle, then give Node a turn to notice an
    // unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toContain("refreshProviders");
    expect(rejections).toEqual([]);
    // The connection is up and stays up: losing one re-announce is recoverable,
    // losing the socket is not.
    expect(statuses).toEqual(["connecting", "online"]);
    expect(relay.online).toBe(true);
    relay.stop();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("reconnects after the socket drops", async () => {
  const { relay, statuses } = client();

  relay.start();
  FakeSocket.instances[0]!.open();
  expect(relay.online).toBe(true);

  // A sleeping laptop, a changed network, a relay deploy — all look like this.
  FakeSocket.instances[0]!.close();
  expect(relay.online).toBe(false);
  expect(statuses).toEqual(["connecting", "online", "offline"]);

  // Backoff is randomised, so wait past the upper bound of the first attempt.
  await new Promise((r) => setTimeout(r, backoffBounds(0).max + 50));
  expect(FakeSocket.instances.length).toBeGreaterThan(1);
  relay.stop();
});

test("backoff grows, is jittered, and is capped", () => {
  const first = backoffBounds(0);
  const later = backoffBounds(3);
  const far = backoffBounds(50);

  expect(first.max).toBe(1_000);
  expect(later.max).toBeGreaterThan(first.max);
  // Jitter: the window is a range, not a fixed delay. Without it every daemon
  // that lost the same relay deploy reconnects in lockstep and re-floors it.
  expect(later.min).toBeLessThan(later.max);
  // Capped, or a machine left asleep for a week would back off for hours.
  expect(far.max).toBe(30_000);
});

test("stop() ends reconnection for good", async () => {
  const { relay } = client();

  relay.start();
  FakeSocket.instances[0]!.open();
  relay.stop();
  FakeSocket.instances[0]!.close();

  await new Promise((r) => setTimeout(r, backoffBounds(0).max + 50));
  // Shutting down must actually shut down; a lingering retry loop would keep
  // the process alive and keep hitting the relay.
  expect(FakeSocket.instances).toHaveLength(1);
});

test("sending while offline is dropped rather than thrown", () => {
  const { relay } = client();

  // Before connecting, and after dropping, the daemon still emits events. They
  // must not become unhandled exceptions that take the process down.
  expect(() => relay.send({ t: "session.event" })).not.toThrow();
  relay.start();
  expect(() => relay.send({ t: "session.event" })).not.toThrow();
  relay.stop();
});

test("relayed messages reach the daemon handler", async () => {
  const { relay, calls } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  calls.length = 0;

  // An unknown type must produce an error reply rather than a crash: the app
  // and daemon can be different versions once this is remote. It carries its
  // own code so a newer app can tell "this daemon is older than me" apart from
  // a real failure and keep it out of the transcript.
  const app = phone();
  // Sealed frames are only read from a device that has proved it holds the key,
  // so the handshake is part of getting a message to the handler at all.
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
  });
  await new Promise((r) => setTimeout(r, 20));
  socket.receive({ ...app.seal({ t: "nonsense" }), from: "Kens-iPhone" });
  await new Promise((r) => setTimeout(r, 20));

  // The reply is sealed too, so reading it means decrypting it — which is also
  // the proof that what went back out was not plaintext.
  const errors = socket.sent
    .map((raw) => app.open(JSON.parse(raw)))
    .filter((m): m is { t: string; code: string } => (m as { t?: string })?.t === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]!.code).toBe("unknown_message");
  relay.stop();
});

test("a phone on the relay is visible to clients on the LAN", async () => {
  // The two transports must be a two-way mirror. Before `onBroadcast` existed,
  // a broadcast triggered by a relay client went back out the relay only, so a
  // desktop client on the same machine never saw a phone that arrived over a
  // mobile network — despite the daemon owning one log precisely so that both
  // can watch the same conversation.
  const local: unknown[] = [];
  const { relay } = client({ onBroadcast: (message) => local.push(message) });

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  const app = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
  });
  // `hello` awaits a provider refresh before broadcasting, so let the
  // microtask queue drain the same way the neighbouring cases do.
  await new Promise((r) => setTimeout(r, 20));

  const joined = local.find((m) => (m as { t?: string }).t === "device.joined");
  expect(joined).toMatchObject({ t: "device.joined", deviceId: "Kens-iPhone" });

  // Still sent up the relay as well: the fan-out is additional, not a redirect.
  expect(
    socket.sent.some((raw) => (app.open(JSON.parse(raw)) as { t?: string })?.t === "device.joined"),
  ).toBe(true);
  relay.stop();
});

test("a relay client with no local listener is still handled", async () => {
  // `onBroadcast` is optional, and omitting it must not turn every relay
  // message into a crash inside the daemon's only remote transport.
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  const app = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
  });
  await new Promise((r) => setTimeout(r, 20));

  expect(
    socket.sent.some((raw) => (app.open(JSON.parse(raw)) as { t?: string })?.t === "device.joined"),
  ).toBe(true);
  relay.stop();
});

test("a malformed or unsealed frame is dropped, not answered", async () => {
  // Answering would be a favour to a stranger. Nothing here has proved it holds
  // the pairing key, so a reply would confirm the room is live and leak the
  // daemon's protocol version — and no legitimate peer ever sends any of this.
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  const before = socket.sent.length;

  socket.onmessage?.({ data: "{ not json" });
  socket.receive({ t: "session.prompt", text: "unsealed" });
  socket.receive({ t: "e", ctr: 0, n: "AA", ct: "AA" });
  await new Promise((r) => setTimeout(r, 20));

  // Still alive, and it said nothing.
  expect(socket.sent.length).toBe(before);
  expect(() => relay.send({ t: "ping" })).not.toThrow();
  relay.stop();
});

test("rotating the pairing moves the daemon into the new relay room", () => {
  // The room id is derived from the token and fixed when the socket opens, so a
  // rotation cannot be applied to a live connection. Before this, `pew2 pair`
  // left the daemon listening in the old room while the freshly paired phone
  // joined the new one, and only a restart cleared it.
  const { relay } = client();
  relay.start();
  FakeSocket.instances[0]!.open();

  const before = FakeSocket.instances.length;
  relay.rekey("new-token", "ff".repeat(32));

  // A fresh socket, pointed at the new room.
  expect(FakeSocket.instances.length).toBe(before + 1);
  expect(relay.endpoint).toContain("pairing=new-token");
  expect(FakeSocket.instances.at(-1)!.url).toContain("pairing=new-token");
  relay.stop();
});

test("rekeying with the same credentials does not drop the connection", () => {
  // The pairing file is written more than once per save, so an unchanged
  // rotation must not cost the phone its live session.
  const { relay } = client({ token: "same-token", key: "aa".repeat(32) });
  relay.start();
  FakeSocket.instances[0]!.open();

  const before = FakeSocket.instances.length;
  relay.rekey("same-token", "aa".repeat(32));

  expect(FakeSocket.instances.length).toBe(before);
  relay.stop();
});

test("a stopped client does not silently start on rekey", () => {
  // `stop()` is called on shutdown. A rotation racing it must not resurrect the
  // socket after the daemon has decided to go away.
  const { relay } = client();
  relay.start();
  FakeSocket.instances[0]!.open();
  relay.stop();

  const before = FakeSocket.instances.length;
  relay.rekey("another-token", "bb".repeat(32));

  expect(FakeSocket.instances.length).toBe(before);
});

test("a rekeyed client does not leave the old socket scheduling retries", () => {
  // Found by rotating twice against a live daemon: the relay flapped between
  // online and offline and nothing could reach it. `rekey` closes the old
  // socket and opens a new one, but the old `onclose` fires *after* that — and
  // unguarded it nulled the new socket and scheduled a retry beside it, so two
  // connections raced each other indefinitely.
  const { relay, statuses } = client();
  relay.start();
  const first = FakeSocket.instances[0]!;
  first.open();

  relay.rekey("rotated-token", "cc".repeat(32));
  const second = FakeSocket.instances.at(-1)!;
  second.open();

  // The old socket's close lands late, after the replacement is already up.
  first.close();

  // Still exactly the two sockets: no retry was scheduled on top of the new one.
  expect(FakeSocket.instances.length).toBe(2);
  expect(relay.online).toBe(true);
  expect(statuses.at(-1)).toBe("online");
  relay.stop();
});

test("the same phone can reconnect over and over", async () => {
  // The bug this exists to stop, and the reason it went unnoticed for a day.
  //
  // A phone builds a fresh SecureChannel per socket, so its replay counter
  // restarts at zero on every reconnect. The daemon's relay channel is one
  // long-lived object shared by every device, and it remembered the highest
  // counter from the last connection — so the *second* connection from the same
  // device was rejected as a replay, permanently, until the daemon restarted.
  //
  // It never showed up in a test because every test used a fresh device id,
  // which sidesteps it completely. Real phones do not: they keep one id for
  // their lifetime, so every reconnect after the first one failed.
  const seen: unknown[] = [];
  const { relay } = client({ onBroadcast: (message) => seen.push(message) });
  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();

  for (let attempt = 0; attempt < 3; attempt++) {
    // A new channel each time, exactly as the app does on reconnect.
    const app = phone();
    socket.receive({
      t: "hello",
      wire: WIRE_VERSION,
      role: "app",
      deviceId: "Kens-iPhone",
      proof: app.proof("Kens-iPhone"),
    });
    await new Promise((r) => setTimeout(r, 20));

    const joins = seen.filter((m) => (m as { t?: string }).t === "device.joined");
    expect(joins.length, `reconnect ${attempt + 1} was not accepted`).toBe(attempt + 1);

    // And the connection is usable, not merely admitted: a sealed frame from
    // the new channel must still open.
    expect(relay.online).toBe(true);
  }

  relay.stop();
});

test("a second device on the same pairing is refused over the relay", async () => {
  // The link never expires, so the claim is what makes a leaked QR worthless.
  // The relay is the path that actually matters here: a recording of a pairing
  // code is usable from anywhere, whereas the LAN socket needs the attacker on
  // the same Wi-Fi.
  //
  // Note what the attacker has: the root key. Their proof verifies. They are
  // stopped by the claim alone.
  const claimed = "Kens-iPhone";
  const { relay } = client({
    admitDevice: (deviceId) =>
      deviceId === claimed ? { ok: true } : { ok: false, message: "already in use" },
  });

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  const attacker = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Mallory-Phone",
    proof: attacker.proof("Mallory-Phone"),
  });
  await new Promise((r) => setTimeout(r, 20));

  // Told why, in cleartext: the app cannot decrypt anything yet, and a silent
  // drop would look identical to a network fault the user would keep retrying.
  const refusal = socket.sent
    .map((raw) => JSON.parse(raw) as { t?: string; code?: string; deviceId?: string })
    .find((m) => m.t === "error" && m.code === "device-refused");
  expect(refusal).toBeDefined();

  // Addressed to the device it refuses. The relay forwards cleartext to every
  // app in the room, so an unaddressed refusal also reaches the phone that owns
  // the pairing — which treats it as fatal and stops reconnecting. That would
  // hand an attacker holding a leaked link a one-frame way to knock the real
  // device offline using the very gate meant to stop them.
  expect(refusal?.deviceId).toBe("Mallory-Phone");

  // And never joined: no announcement, so nothing downstream treats it as a
  // present device.
  expect(
    socket.sent.some((raw) => {
      const opened = attacker.open(JSON.parse(raw)) as { t?: string } | null;
      return opened?.t === "device.joined";
    }),
  ).toBe(false);
  relay.stop();
});

test("a refused device does not get its replay window cleared", async () => {
  // `acceptHandshake` resets the counters a replay check depends on. Doing that
  // for a device the gate then refuses would let anyone holding a leaked link
  // wipe the real phone's replay protection by simply announcing its name — and
  // from there replay a captured `session.permission` to re-approve a tool call
  // the user approved once.
  const { relay } = client({ admitDevice: () => ({ ok: false, message: "already in use" }) });

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  const attacker = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: attacker.proof("Kens-iPhone"),
  });
  await new Promise((r) => setTimeout(r, 20));
  socket.sent.length = 0;

  // A sealed frame from the refused device must go nowhere.
  socket.receive({ ...attacker.seal({ t: "hello" }), from: "Kens-iPhone" });
  await new Promise((r) => setTimeout(r, 20));

  expect(socket.sent).toHaveLength(0);
  relay.stop();
});

test("without a gate every prover is admitted, so the check is opt-in", async () => {
  // Pins the fallback: `admitDevice` is optional, and a daemon that does not
  // supply one must keep working exactly as before rather than refusing
  // everything.
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  const app = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
  });
  await new Promise((r) => setTimeout(r, 20));

  expect(
    socket.sent.some((raw) => (app.open(JSON.parse(raw)) as { t?: string })?.t === "device.joined"),
  ).toBe(true);
  relay.stop();
});

test("a reconnecting phone is answered with everything it missed", async () => {
  // This is the transport that needs it. A phone reconnects through here every
  // time the screen locks or the radio switches, and `send` drops anything
  // emitted while the socket was down — so without this the agent's work during
  // the gap is gone for good and the phone silently resumes at the live edge.
  const missed = { t: "session.replay", sessionId: "s1", events: [], catchUp: true, working: true };
  const { relay, cursorsSeen } = client({}, { catchUp: () => [missed] });

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.sent.length = 0;

  const app = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
    // A fractional seq and a negative one are junk: `hello` is read before the
    // channel exists, so it is never schema-validated as a whole.
    cursors: { s1: 41, s2: 2.5, s3: -1 },
  });
  await new Promise((r) => setTimeout(r, 20));

  expect(cursorsSeen).toEqual([{ s1: 41 }]);
  const frames = socket.sent.map((raw) => app.open(JSON.parse(raw)));
  expect(frames).toContainEqual(missed);
  relay.stop();
});

test("a phone that names no cursors is not sent a catch-up it never asked for", async () => {
  const { relay, cursorsSeen } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();

  const app = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
  });
  await new Promise((r) => setTimeout(r, 20));

  // Asked, and answered with nothing — a fresh app holds no sessions.
  expect(cursorsSeen).toEqual([{}]);
  relay.stop();
});

/** Statuses with their details, for the tests that care why. */
function detailedClient(overrides: Partial<RelayClientOptions> = {}) {
  const events: string[] = [];
  const made = client({
    onStatus: (status, detail) => events.push(detail ? `${status}: ${detail}` : status),
    ...overrides,
  });
  return { ...made, events };
}

test("a relay that stops answering is abandoned rather than trusted for minutes", async () => {
  // A half-open socket never fires close: the daemon went on believing it was
  // connected while the relay admitted phones into a room it could not hear.
  const { relay, events } = detailedClient({ heartbeatMs: 20 });
  relay.start();
  const first = FakeSocket.instances[0]!;
  first.open();

  await new Promise((r) => setTimeout(r, 20 * 2.5 + 40));

  expect(events).toContain("offline: no reply from relay");
  expect(first.readyState).toBe(3);
  expect(relay.online).toBe(false);
  relay.stop();
});

test("a relay that answers its pings keeps the connection", async () => {
  const { relay, events } = detailedClient({ heartbeatMs: 20 });
  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();

  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 15));
    socket.receive({ t: "pong" });
  }

  expect(events.filter((e) => e.startsWith("offline"))).toEqual([]);
  expect(relay.online).toBe(true);
  relay.stop();
});

test("a connection that never opens is given up on", async () => {
  const { relay, events } = detailedClient({ connectTimeoutMs: 20 });
  relay.start();

  await new Promise((r) => setTimeout(r, 60));

  expect(events).toContain("offline: connect timed out");
  expect(FakeSocket.instances[0]!.readyState).toBe(3);
  relay.stop();
});

test("a close says why, so the log can explain the disconnect", () => {
  const { relay, events } = detailedClient();
  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();

  socket.readyState = 3;
  (socket.onclose as unknown as (event: { code: number; reason: string }) => void)({
    code: 4009,
    reason: "another daemon holds this room",
  });

  expect(events).toContain("offline: closed 4009: another daemon holds this room");
  relay.stop();
});

/**
 * A relay stand-in for the refusal tests: a real HTTP server, because the thing
 * under test is what a real WebSocket client and `fetch` make of its answer.
 * Refuses the way `admission.ts` refuses a second daemon, or admits.
 */
function fakeRelay(answer: "refuse" | "admit") {
  const seen: { role: string | null; upgrade: string | null }[] = [];
  let socketsClosed = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, srv) {
      const url = new URL(request.url);
      seen.push({ role: url.searchParams.get("role"), upgrade: request.headers.get("upgrade") });
      if (answer === "refuse") {
        return new Response("a live daemon is already connected", { status: 409 });
      }
      if (srv.upgrade(request)) return undefined;
      return new Response("expected websocket upgrade", { status: 426 });
    },
    websocket: {
      message() {},
      close() {
        socketsClosed++;
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    seen,
    socketsClosed: () => socketsClosed,
    stop: () => server.stop(true),
  };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Close a fake socket the way Bun reports a refused upgrade: before it ever opened. */
function refuseUpgrade(socket: FakeSocket) {
  socket.readyState = 3;
  (socket.onclose as unknown as (event: { code: number; reason: string }) => void)({
    code: 1002,
    reason: "Expected 101 status code",
  });
}

const TOKEN = "t".repeat(48);

test("a refused upgrade logs the relay's status and reason, not just 'Expected 101'", async () => {
  // The incident: another daemon held the room, the relay said 409 and why,
  // and the log said only "closed 1002: Expected 101 status code".
  const relayServer = fakeRelay("refuse");
  const { relay, events } = detailedClient({
    url: relayServer.url,
    createSocket: (url) => new WebSocket(url),
  });
  try {
    relay.start();
    await until(() => events.some((e) => e.startsWith("offline")));

    const offline = events.find((e) => e.startsWith("offline"))!;
    expect(offline).toBe(
      "offline: relay refused the connection: 409 a live daemon is already connected" +
        " (is another pew2 daemon running with this pairing?)",
    );
    // The same request both times: a daemon-role upgrade to the same room.
    expect(relayServer.seen).toEqual([
      { role: "daemon", upgrade: "websocket" },
      { role: "daemon", upgrade: "websocket" },
    ]);
    for (const event of events) expect(event).not.toContain(TOKEN);
  } finally {
    relay.stop();
    await relayServer.stop();
  }
});

test("a refusal that has passed by the second look says so, and lets that socket go", async () => {
  // The room freed up between the refusal and the probe. The probe must not
  // keep its socket, or the relay would refuse the real retry as a second daemon.
  const relayServer = fakeRelay("admit");
  const { relay, events } = detailedClient({ url: relayServer.url });
  try {
    relay.start();
    refuseUpgrade(FakeSocket.instances[0]!);
    await until(() => events.some((e) => e.startsWith("offline")));

    expect(events).toContain(
      "offline: closed 1002: Expected 101 status code" +
        " (the relay let a second attempt in, so the refusal has passed)",
    );
    await until(() => relayServer.socketsClosed() === 1);
  } finally {
    relay.stop();
    await relayServer.stop();
  }
});

test("a probe still out when the client stops reports nothing and retries nothing", async () => {
  let answer: (refusal: RelayRefusal) => void = () => {};
  const { relay, events } = detailedClient({
    probeRefusal: () => new Promise((resolve) => (answer = resolve)),
  });
  relay.start();
  refuseUpgrade(FakeSocket.instances[0]!);

  relay.stop();
  answer({ kind: "refused", status: 409, reason: "a live daemon is already connected" });
  await new Promise((r) => setTimeout(r, 20));

  expect(events.filter((e) => e.startsWith("offline"))).toEqual([]);
  expect(FakeSocket.instances).toHaveLength(1);
});

test("a socket that opened and then closed is not probed", () => {
  // 1002 after the upgrade is a protocol error on a live socket, not a refusal.
  let probes = 0;
  const { relay, events } = detailedClient({
    probeRefusal: async () => {
      probes++;
      return { kind: "admitted" };
    },
  });
  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  refuseUpgrade(socket);

  expect(probes).toBe(0);
  expect(events).toContain("offline: closed 1002: Expected 101 status code");
  relay.stop();
});

test("a relay that cannot be asked is reported without the pairing token", async () => {
  // Nothing listens here once the server is stopped. Fetch errors can carry the
  // URL, and the URL carries the token.
  const relayServer = fakeRelay("refuse");
  const endpoint = `${relayServer.url}/connect?pairing=${TOKEN}&role=daemon&deviceId=x`;
  await relayServer.stop();

  const refusal = await probeRefusal(endpoint, 2_000);

  expect(refusal.kind).toBe("error");
  const line = describeRefusal(refusal, "closed 1002: Expected 101 status code", TOKEN);
  expect(line).toStartWith("closed 1002: Expected 101 status code (could not ask the relay why: ");
  expect(line).not.toContain(TOKEN);
});

test("a refusal body is shortened, flattened, and scrubbed of the token", () => {
  const line = describeRefusal(
    { kind: "refused", status: 400, reason: `bad pairing ${TOKEN} ${"x".repeat(500)}` },
    undefined,
    TOKEN,
  );
  expect(line).not.toContain(TOKEN);
  expect(line).toContain("relay refused the connection: 400 bad pairing [pairing]");
  expect(line.length).toBeLessThan(260);
  // A 409 hint is only for a 409.
  expect(line).not.toContain("another pew2 daemon");
});

test("the reconnect key goes in a header, never the URL; a takeover by another daemon here stops it", async () => {
  const key = "ab".repeat(32);
  const { relay } = client({ resumeKey: key });
  relay.start();
  const first = FakeSocket.instances[0]!;
  expect(first.headers).toEqual({ "x-pew2-resume": key });
  expect(first.url).not.toContain(key);
  first.open();
  // Replaced while up: another pew2 on this machine took the room.
  first.readyState = 3;
  first.onclose?.({ code: 1012, reason: "replaced by a newer daemon connection" });
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  const next = FakeSocket.instances[1];
  expect(next).toBeDefined();
  expect(next!.headers).toEqual({});
  relay.stop();
});

test("no key configured: connects exactly as before", () => {
  const { relay } = client();
  relay.start();
  expect(FakeSocket.instances[0]!.headers).toEqual({});
  relay.stop();
});
