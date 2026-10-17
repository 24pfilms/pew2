/**
 * Outbound connection to the relay. This is what makes pew2 work from anywhere.
 *
 * The daemon *dials out*, so the user's machine needs no public address, no port
 * forwarding and no hole in their firewall — the same reason a laptop can reach
 * a chat server from a café. The phone dials out too, from whatever mobile
 * network it is on, and the relay's Durable Object is the meeting point.
 *
 * Reconnection is the whole job. A desktop sleeps, a Wi-Fi network changes, a
 * relay deploys: all of these drop the socket, and the user is not there to
 * restart anything. So this reconnects forever, with backoff and jitter, and
 * never gives up — an agent that stops being reachable after one blip is worse
 * than no remote access at all.
 */
import { handleMessage } from "./handler.js";
import { SecureChannel, e2e, envelopeHeader, wire } from "@pew2/protocol";
import type { Daemon } from "./index.js";

export interface RelayClientOptions {
  daemon: Daemon;
  /** Relay origin, e.g. `wss://relay.example.com`. */
  url: string;
  /**
   * The relay room id. Selects the Durable Object both sides meet in.
   *
   * Derived one-way from the pairing key, so handing it to the relay does not
   * hand over the ability to read anything.
   */
  token: string;
  /** The pairing key, hex. Never sent — only used to seal and open frames. */
  key: string;
  /** Stable identity for this machine, so the relay can tell devices apart. */
  deviceId: string;
  cwd?: string;
  onStatus?: (status: RelayStatus, detail?: string) => void;
  /**
   * Also deliver relay-originated broadcasts to locally connected clients.
   *
   * Without this the two transports are one-way mirrors: a phone acting over
   * the relay is invisible to a client on the LAN, even though the daemon
   * owning one log is the entire reason both can watch the same session. It is
   * also what lets `pew2 pair` confirm a phone that arrived from a mobile
   * network rather than the local Wi-Fi.
   */
  onBroadcast?: (message: unknown) => void;
  /**
   * Decide whether a device that has proved it holds the key may connect.
   *
   * Supplied by the daemon so the relay and the LAN socket enforce one rule: a
   * pairing link admits a single device, and a leaked copy of it is refused.
   * Absent in tests that predate the gate, which then admit every prover.
   */
  admitDevice?: (deviceId: string) => { ok: boolean; message?: string };
  /** Injectable for tests. Defaults to the global WebSocket. */
  createSocket?: (url: string) => WebSocket;
  /** Injectable for tests. Defaults to {@link HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** Injectable for tests. Defaults to {@link CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Injectable for tests. Defaults to {@link probeRefusal}. */
  probeRefusal?: (endpoint: string) => Promise<RelayRefusal>;
}

export type RelayStatus = "connecting" | "online" | "offline";

/**
 * What a second look at a refused upgrade found.
 *
 * `refused` is the relay's own answer — the status and the reason it gave.
 * `admitted` means the refusal had already passed by the time of the second
 * look. `error` means the second look could not get an answer at all.
 */
export type RelayRefusal =
  | { kind: "refused"; status: number; reason: string }
  | { kind: "admitted" }
  | { kind: "error"; error: string };

/**
 * The close code a WebSocket client reports when the server answered the
 * upgrade with something other than 101.
 *
 * All Bun's client says is `1002: Expected 101 status code`. The status and the
 * body the relay sent with it — `409 a live daemon is already connected` — are
 * read and thrown away, and they are the only part that explains anything.
 */
const UPGRADE_REFUSED = 1002;

/** How long the second look at a refused upgrade may take. */
const PROBE_TIMEOUT_MS = 5_000;

/** Longest stretch of a refusal body that goes into the log. */
const MAX_REASON_LENGTH = 200;

/** Backoff bounds. One second is fast enough to feel instant after a blip. */
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Ping interval. Long-lived idle WebSockets are silently dropped by NATs and
 * mobile carriers; without traffic the daemon believes it is connected while
 * the phone sees nothing.
 */
const HEARTBEAT_MS = 25_000;

/**
 * Heartbeats that may pass unanswered before the socket is presumed dead.
 *
 * The relay answers every ping, so a healthy link is heard from at least once
 * per heartbeat. Two and a half allows for one lost pong and a slow one without
 * holding a dead socket for minutes: a half-open TCP connection otherwise
 * survives until the operating system gives up retransmitting, while the relay
 * goes on admitting phones into a room whose daemon cannot hear them — and
 * refuses this daemon's own fresh reconnect until it times the old one out.
 */
const SILENT_HEARTBEATS = 2.5;

/**
 * How long a connection attempt may take before it is abandoned.
 *
 * Opening is TCP, TLS and the upgrade — a few round trips. Ten seconds is well
 * past any real one and well short of an operating-system connect timeout.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * The keepalive, in cleartext and byte-for-byte fixed.
 *
 * The relay answers this exact string from the Durable Object's hibernation
 * auto-response, so it never wakes the object at all — see `KEEPALIVE_REQUEST`
 * in `packages/relay/src/index.ts`, which must match this character for
 * character. Sealed it could not be: every frame carries a fresh nonce, so no
 * two pings look alike and the runtime would wake for every one of them.
 *
 * Nothing is given away by sending it in the open. It carries no content, and
 * the relay can already see the timing of every frame that passes through it.
 */
export const KEEPALIVE_FRAME = '{"t":"ping"}';

/** The relay's answer, which the LAN socket gives too. See `KEEPALIVE_RESPONSE` in the relay. */
export const KEEPALIVE_REPLY = '{"t":"pong"}';

export class RelayClient {
  private socket: WebSocket | null = null;
  /**
   * Encryption state for the current connection.
   *
   * Rebuilt on every reconnect, because the counters that make replay
   * detectable are only meaningful within one socket: carrying them across a
   * reconnect would make the fresh connection's first frames look like replays.
   */
  private channel: SecureChannel | null = null;
  private attempts = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the relay last sent anything at all — a pong counts. */
  private lastHeardAt = 0;
  /**
   * Bumped by every connection attempt, so a refusal probe that comes back after
   * `stop`, `rekey` or a newer attempt knows it has nothing left to report to.
   */
  private generation = 0;

  constructor(private readonly options: RelayClientOptions) {}

  /**
   * Point this client at a new pairing and reconnect into its room.
   *
   * `pew2 pair --rotate` mints a new token and writes it to disk, but a daemon
   * that is already running holds the old one — and the relay room is derived
   * from it. Without this the daemon sits in a room the freshly paired phone
   * will never join: the phone shows "connecting" forever, re-pairing makes it
   * worse rather than better, and only a restart clears it.
   */
  rekey(nextToken: string, nextKey: string): void {
    if (nextToken === this.options.token && nextKey === this.options.key) return;
    // Written through a computed key: the fields are readonly to everyone
    // else, and this is the one place allowed to move them.
    const opts = this.options as unknown as Record<string, unknown>;
    opts["token"] = nextToken;
    opts["key"] = nextKey;
    // Straight back out and in: the room id is fixed at connect time, so an
    // open socket cannot be moved to the new one.
    const wasRunning = !this.stopped;
    this.stop();
    if (wasRunning) this.start();
  }

  /** Where this daemon connects. The token never appears in logs. */
  get endpoint(): string {
    const base = this.options.url.replace(/\/$/, "");
    const params = new URLSearchParams({
      pairing: this.options.token,
      role: "daemon",
      deviceId: this.options.deviceId,
    });
    return `${base}/connect?${params}`;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.socket?.close();
    } catch {
      // Already closed; nothing to do.
    }
    this.socket = null;
  }

  /** Push a sealed message to the relay. Silently dropped while offline. */
  send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.channel) return;
    try {
      this.socket.send(JSON.stringify(this.channel.seal(message, envelopeHeader(message))));
    } catch {
      // A send failing means the socket is already gone; `close` will fire and
      // reconnection will take over.
    }
  }

  get online(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private status(status: RelayStatus, detail?: string) {
    this.options.onStatus?.(status, detail);
  }

  private connect(): void {
    if (this.stopped) return;
    this.generation++;
    this.status("connecting");

    let socket: WebSocket;
    try {
      socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.endpoint);
    } catch (error) {
      // A malformed URL throws synchronously. Treat it as any other failure so
      // a typo'd relay does not kill the daemon.
      this.scheduleRetry((error as Error).message);
      return;
    }
    this.socket = socket;
    let opened = false;

    this.connectTimer = setTimeout(() => {
      if (this.socket === socket && socket.readyState !== WebSocket.OPEN) {
        this.abandon(socket, "connect timed out");
      }
    }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();

    socket.onopen = () => {
      opened = true;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.lastHeardAt = Date.now();
      this.attempts = 0;
      this.status("online");
      this.channel = new SecureChannel(e2e.fromHex(this.options.key), "daemon");
      // `hello` is cleartext because it is what establishes the connection, and
      // carries a sealed proof beside it so the far side can tell a real daemon
      // from anyone who merely learned the room id.
      socket.send(
        JSON.stringify({
          t: "hello",
          wire: wire.WIRE_VERSION,
          role: "daemon",
          deviceId: this.options.deviceId,
          proof: this.channel.proof(this.options.deviceId),
        }),
      );
      // The app may have been waiting on the relay long before this machine woke
      // up, so re-announce rather than assuming it saw the last one.
      //
      // Deliberately not awaited — `onopen` is synchronous and the connection is
      // already usable without it. But the rejection still has to be caught:
      // re-scanning providers touches the disk and spawns probes, and an
      // unhandled rejection here takes down the whole daemon on a transient
      // failure, at the exact moment the user is trying to reconnect.
      void this.options.daemon.refreshProviders().catch(() => {
        // The next refresh picks it up; losing one re-announce is not worth
        // dropping the connection that just came up.
      });
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      // Anything at all — a pong included — shows the path is alive.
      this.lastHeardAt = Date.now();
      const raw = typeof event.data === "string" ? event.data : null;
      if (raw === null || !this.channel) return;

      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }

      if (typeof frame !== "object" || frame === null) return;
      const kind = (frame as { t?: unknown }).t;

      // An app announcing itself. Cleartext, because it is what establishes the
      // far end of the connection — so it carries a sealed proof beside it, and
      // is worth nothing without one.
      if (kind === "hello") {
        const hello = frame as {
          wire?: unknown;
          deviceId?: unknown;
          proof?: unknown;
          cursors?: unknown;
        };
        const deviceId = typeof hello.deviceId === "string" ? hello.deviceId : "";

        // Checked first, so a client too old to carry a proof is told to update
        // rather than dismissed as unpaired — different problems, different fixes.
        const mismatch = wire.wireMismatch(hello.wire);
        if (mismatch) {
          socket.send(JSON.stringify({ t: "error", code: "wire-version", message: mismatch }));
          return;
        }
        // A `hello` is a new socket, and the peer's counters restart at zero
        // with it, so the window this channel remembers from the last connection
        // has to be cleared or that first frame reads as a replay — which
        // stranded the app on "getting the list of agents" and left `pew2 pair`
        // waiting for a phone that had already arrived.
        //
        // The proof comes first, and the clearing is only reachable through it.
        // The other order let a cleartext `hello` naming any device wipe that
        // device's replay protection without holding the key at all: whoever
        // knew the relay room id could then replay a captured `session.permission`
        // and re-approve a tool call the user approved once.
        if (!deviceId) return;
        if (!this.channel.verifyProof(hello.proof, deviceId)) return;

        // One pairing, one device. Enforced here as well as on the LAN socket:
        // a leaked link is most useful to an attacker from off the network, so
        // the relay is the path that actually needs this.
        //
        // Decided before the handshake is accepted, so a refused device never
        // gets its replay window cleared — which was the whole reason the proof
        // has to come first. Synchronous by design: this runs inside the socket's
        // message handler, and an await here would let the next frame overtake
        // the handshake it depends on.
        const decision = this.options.admitDevice?.(deviceId);
        if (decision && !decision.ok) {
          // Cleartext, like the version mismatch above and for the same reason:
          // this refusal is what stops the channel being established, so there
          // is no sealed path to send it down. It carries no user content — only
          // that this pairing belongs to another device.
          //
          // Addressed to the device it refuses, because the relay fans cleartext
          // out to every app in the room: only sealed frames are stamped and
          // routed. Unaddressed, this refusal would also land on the phone that
          // legitimately owns the pairing, which treats it as fatal and stops
          // reconnecting — handing an attacker a one-frame way to knock the real
          // device offline with the very gate meant to stop them.
          socket.send(
            JSON.stringify({
              t: "error",
              code: "device-refused",
              deviceId,
              message: decision.message,
            }),
          );
          return;
        }
        this.channel.acceptHandshake(deviceId);

        // The app may have been waiting here long before this machine woke up,
        // so re-announce rather than assume it saw the last list.
        //
        // Caught, like the call in `onopen`. This one was missed when that was
        // fixed, and it is the worse of the two: it runs the moment a phone
        // arrives, so a transient scan failure took the daemon down at exactly
        // the moment someone was watching `pew2 pair` for confirmation.
        void this.options.daemon.refreshProviders().catch(() => {
          // The phone is joined either way; the next refresh carries the list.
        });
        const joined = { t: "device.joined", deviceId, at: Date.now() };
        this.send(joined);
        this.options.onBroadcast?.(joined);

        // Everything this phone missed while it was away. This is the path that
        // needs it: a phone off the LAN reconnects through here every time the
        // screen locks, and the turn it left running kept producing events that
        // this socket was not up to carry.
        //
        // Not mirrored to `onBroadcast` — it is addressed to the client that
        // asked, and replaying it to the desktop's own listeners would re-run
        // events they have already seen.
        for (const catchUp of this.options.daemon.catchUp(wire.readCursors(hello.cursors))) {
          this.send(catchUp);
        }
        return;
      }

      // Everything else must be sealed. A cleartext frame from the relay itself
      // — `ready`, or an error — carries nothing this needs to act on.
      if (kind !== "e") return;

      // Partitioned by the sender the relay names, so several phones sharing
      // this one socket do not invalidate each other's counters.
      //
      // Required, not defaulted: the relay stamps every sealed frame with the
      // sending socket's device id, so a frame without one did not come through
      // the path this channel's replay windows describe. Falling back to the
      // unlabelled sender would put it in a window no device ever proved.
      const sender = (frame as { from?: unknown }).from;
      if (typeof sender !== "string" || sender === "") return;
      const message = this.channel.open(frame, sender);
      if (message === undefined) return;

      void handleMessage(JSON.stringify(message), {
        daemon: this.options.daemon,
        // The relay stamps each sealed frame with the sending socket's device
        // id, and `open` above only succeeded because that id's channel state
        // decrypted it — so this is the sender the frame was actually verified
        // against, not a label it chose for itself.
        deviceId: sender,
        // Over the relay there is no per-client socket to reply to: the relay
        // fans out to whichever apps are attached to this pairing. Both paths
        // therefore go back the same way.
        reply: (message) => this.send(message),
        broadcast: (message) => {
          this.send(message);
          this.options.onBroadcast?.(message);
        },
        cwd: this.options.cwd,
      });
    };

    socket.onerror = () => {
      // Errors are always followed by close; retrying here as well would open
      // two sockets for one failure.
    };

    socket.onclose = (event?: { code?: number; reason?: string }) => {
      this.clearTimers();
      // Only tear down state that still belongs to *this* socket. `rekey`
      // closes the old one and immediately opens a new one, and `onclose`
      // arrives after that \u2014 so an unconditional reset here would null the new
      // socket and schedule a retry beside it, leaving two connections racing
      // and the relay flapping between online and offline.
      if (this.socket !== socket) return;
      this.socket = null;
      this.channel = null;
      // The code says who ended it and why \u2014 the relay refusing a second
      // daemon, a deploy, a network drop \u2014 which is what the log needs to
      // explain a disconnect after the fact.
      const code = event?.code;
      const detail = code ? `closed ${code}${event?.reason ? `: ${event.reason}` : ""}` : undefined;
      // Refused before it ever opened. The close code cannot say why, so ask
      // the relay again and log its answer instead.
      if (!opened && code === UPGRADE_REFUSED) {
        void this.explainRefusal(detail);
        return;
      }
      this.scheduleRetry(detail);
    };
  }

  /**
   * Find out why the relay refused the upgrade, then retry as usual.
   *
   * This is what turns "closed 1002: Expected 101 status code" into "refused
   * 409: a live daemon is already connected" — the difference between a log
   * that says something broke and one that says another daemon has this room.
   */
  private async explainRefusal(fallback?: string): Promise<void> {
    const generation = this.generation;
    const refusal = await (this.options.probeRefusal ?? probeRefusal)(this.endpoint);
    // Stopped, rekeyed, or already dialling again while the probe was out.
    if (this.stopped || generation !== this.generation) return;
    this.scheduleRetry(describeRefusal(refusal, fallback, this.options.token));
  }

  /**
   * Give up on a socket that has stopped working without closing.
   *
   * A half-open connection never fires `close` on its own \u2014 that is the
   * failure \u2014 so its handlers are dropped and the retry starts here, rather
   * than waiting on a close event that may not come for minutes.
   */
  private abandon(socket: WebSocket, detail: string): void {
    if (this.socket !== socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    this.clearTimers();
    this.socket = null;
    this.channel = null;
    try {
      socket.close();
    } catch {
      // Already closed; nothing to do.
    }
    this.scheduleRetry(detail);
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    const interval = this.options.heartbeatMs ?? HEARTBEAT_MS;
    this.heartbeat = setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastHeardAt > interval * SILENT_HEARTBEATS) {
        this.abandon(socket, "no reply from relay");
        return;
      }
      try {
        socket.send(KEEPALIVE_FRAME);
      } catch {
        // The socket is already gone; `close` fires and reconnection takes over.
      }
    }, interval);
    // Do not hold the process open for the sake of a keepalive.
    this.heartbeat.unref?.();
  }

  private clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private clearTimers() {
    this.clearHeartbeat();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry(detail?: string): void {
    if (this.stopped) return;
    this.status("offline", detail);

    // Exponential backoff with jitter. Without jitter, every daemon that lost
    // the same relay deploy reconnects in lockstep and knocks it over again.
    const backoff = Math.min(MIN_BACKOFF_MS * 2 ** this.attempts, MAX_BACKOFF_MS);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.attempts++;

    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref?.();
  }
}

/**
 * Ask the relay why it refused a WebSocket upgrade.
 *
 * The same request the WebSocket client made — same URL, same upgrade headers —
 * sent through `fetch`, which hands back the status and body the client threw
 * away. The relay decides admission before it looks at anything else, so a
 * refusal it repeats here is the refusal it gave a moment ago.
 *
 * If the room has freed up in between, the relay admits this one instead and
 * answers 101. That socket is dropped straight away: it is not the connection,
 * and holding it would make the real retry the one refused as a second daemon.
 */
export async function probeRefusal(
  endpoint: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<RelayRefusal> {
  const url = endpoint.replace(/^ws(s?):/i, "http$1:");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
          "base64",
        ),
      },
      signal: controller.signal,
    });
    if (response.status === 101) {
      controller.abort();
      return { kind: "admitted" };
    }
    const reason = (await response.text()).replace(/\s+/g, " ").trim();
    return { kind: "refused", status: response.status, reason };
  } catch (error) {
    // The code or name only. A fetch error's message and `path` can carry the
    // URL, and the URL carries the pairing token.
    const { code, name } = error as { code?: unknown; name?: unknown };
    const label = typeof code === "string" ? code : typeof name === "string" ? name : "unknown";
    return { kind: "error", error: label };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The log line for a refused upgrade.
 *
 * Scrubbed of the pairing token whatever the relay sent back. Nothing the relay
 * says today contains it, but this line goes to a file on disk, and the token is
 * the one thing that must never end up there.
 */
export function describeRefusal(
  refusal: RelayRefusal,
  fallback: string | undefined,
  token: string,
): string {
  const scrub = (text: string) => (token ? text.replaceAll(token, "[pairing]") : text);
  const closed = fallback ?? `closed ${UPGRADE_REFUSED}`;
  switch (refusal.kind) {
    case "refused": {
      const reason = refusal.reason.slice(0, MAX_REASON_LENGTH);
      // A 409 to the daemon role means one thing: another daemon is attached to
      // this pairing and still answering, which is worth saying in so many words.
      const hint =
        refusal.status === 409 ? " (is another pew2 daemon running with this pairing?)" : "";
      return scrub(
        `relay refused the connection: ${refusal.status}${reason ? ` ${reason}` : ""}${hint}`,
      );
    }
    case "admitted":
      return scrub(`${closed} (the relay let a second attempt in, so the refusal has passed)`);
    case "error":
      return scrub(`${closed} (could not ask the relay why: ${refusal.error})`);
  }
}

/** Compute the delay for a given attempt. Exported for testing the curve. */
export function backoffBounds(attempt: number): { min: number; max: number } {
  const backoff = Math.min(MIN_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return { min: backoff / 2, max: backoff };
}
