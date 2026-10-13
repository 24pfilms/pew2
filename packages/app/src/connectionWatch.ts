/**
 * Whether one socket to the daemon is actually working — not merely open.
 *
 * An open WebSocket proves very little on a phone. Four ways it lies, each of
 * which left the app saying "online" while nothing reached the machine:
 *
 * - **Open but never proven.** The relay accepts the socket before the daemon
 *   has seen this phone's `hello`. A proof the daemon refuses (clock skew, a
 *   rotated key) is refused silently, so "online" was announced for a channel
 *   that would never carry a single frame.
 * - **Dead without a close.** A network switch or Doze leaves the TCP
 *   connection half open: no FIN, no error, `readyState` still OPEN, and the
 *   operating system takes minutes to notice. Nothing pinged, so nothing did.
 * - **The daemon came back.** A daemon that reconnects to the relay builds a
 *   fresh channel whose counters restart at zero and which has never seen this
 *   phone. Every frame it sends is rejected here as a replay, and every frame
 *   sent from here is dropped there as from a stranger — both ways dead, while
 *   the socket itself is perfectly healthy. Its cleartext `hello`, which says
 *   exactly that, used to be thrown away.
 * - **The channel broke some other way.** Sealed frames that keep failing to
 *   open mean the two ends no longer agree, whatever the cause.
 *
 * Every one of those is answered the same way: say why, and start a new
 * connection. The new socket brings a new channel and a new `hello`, which is
 * the one path through all of this that is already known to work.
 *
 * Pure, with its timers injected, so every case is a test rather than a guess —
 * and with no `react-native` import, because `useDaemon` (which owns this) is
 * reached by the daemon's own TypeScript program. The same approach as
 * creativeprofit22/pew2's `daemonConnection.ts`, which first held the
 * reconnect deadline until an authenticated frame.
 */

/** Why a connection is being replaced. Logged, so a drop can be explained later. */
export type ReconnectReason =
  | "handshake-timeout"
  | "no-pong"
  | "daemon-rejoined"
  | "channel-broken"
  | "network-changed";

/** The keepalive the relay answers on the daemon's behalf without waking it. */
export const PING_FRAME = '{"t":"ping"}';

/** How long a socket may take to open *and* prove itself with a sealed frame. */
export const HANDSHAKE_TIMEOUT = 10_000;

/**
 * Ping cadence while the app is on screen.
 *
 * Under the 25 s the daemon uses, and well under the 30-60 s many carrier NATs
 * allow an idle mapping, so the path stays warm as well as watched.
 */
export const PING_INTERVAL = 20_000;

/** How long a ping may go unanswered before the socket is presumed dead. */
export const PONG_TIMEOUT = 5_000;

/**
 * The tighter deadline used when the app comes back to the screen.
 *
 * That is the moment someone is looking at the status, and a socket that has
 * spent the last ten minutes in someone's pocket is the likeliest to be a
 * zombie. Three seconds is several round trips even on a weak mobile signal.
 */
export const PROBE_TIMEOUT = 3_000;

/** Undecryptable sealed frames in a row before the channel is declared broken. */
export const BROKEN_CHANNEL_FRAMES = 3;

/**
 * Is this cleartext frame the paired daemon announcing a fresh connection?
 *
 * The daemon's `hello` carries a proof sealed with the pairing key, so it can be
 * checked here before acting on it — otherwise anyone who learned the relay room
 * id could keep this phone reconnecting. Typed against the one method it needs,
 * so this module stays free of the protocol package's runtime.
 */
export function isGenuineDaemonHello(
  channel: { verifyProof(envelope: unknown, deviceId: string): boolean },
  frame: unknown,
): boolean {
  const hello = frame as { t?: unknown; role?: unknown; deviceId?: unknown; proof?: unknown } | null;
  if (hello?.t !== "hello" || hello.role !== "daemon" || typeof hello.deviceId !== "string") {
    return false;
  }
  return channel.verifyProof(hello.proof, hello.deviceId);
}

export interface WatchTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ConnectionWatchOptions {
  /** Write the keepalive. Must not throw when the socket is already gone. */
  sendPing: () => void;
  /** Replace this connection. Called at most once per watch. */
  reconnect: (reason: ReconnectReason) => void;
  /** The first sealed frame opened: the channel works in both directions. */
  onProven: () => void;
  timers: WatchTimers;
  handshakeTimeout?: number;
  pingInterval?: number;
  pongTimeout?: number;
  probeTimeout?: number;
}

export class ConnectionWatch {
  private proven = false;
  private stopped = false;
  private rejectedInARow = 0;
  private handshakeTimer: unknown;
  private pingTimer: unknown;
  private pongTimer: unknown;

  constructor(private readonly options: ConnectionWatchOptions) {
    // Armed at construction, not at `open`: a socket that never opens is the
    // same failure as one that opens and never proves itself.
    this.handshakeTimer = options.timers.set(
      () => this.fail("handshake-timeout"),
      options.handshakeTimeout ?? HANDSHAKE_TIMEOUT,
    );
  }

  get isProven(): boolean {
    return this.proven;
  }

  /** Any frame at all arrived: the path is alive, whatever the frame says. */
  heard(): void {
    if (this.stopped) return;
    this.clearPong();
  }

  /** A sealed frame opened. The first one proves the channel. */
  sealed(): void {
    if (this.stopped) return;
    this.rejectedInARow = 0;
    this.heard();
    if (this.proven) return;
    this.proven = true;
    this.options.timers.clear(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.options.onProven();
    this.schedulePing();
  }

  /**
   * A sealed frame that would not open.
   *
   * One is noise — a stray frame from an older channel, a duplicate. Several
   * in a row, on a channel that was working, is the far side speaking a channel
   * this one is not part of.
   */
  rejected(): void {
    if (this.stopped) return;
    this.heard();
    this.rejectedInARow += 1;
    if (this.proven && this.rejectedInARow >= BROKEN_CHANNEL_FRAMES) this.fail("channel-broken");
  }

  /**
   * The daemon announced a fresh connection to the relay.
   *
   * `genuine` must come from checking the proof it carries against the pairing
   * key, so that only the paired machine — not anyone holding the room id — can
   * make this phone reconnect.
   */
  daemonHello(genuine: boolean): void {
    if (this.stopped || !genuine) return;
    this.fail("daemon-rejoined");
  }

  /**
   * Check now, with a short deadline: the app has just come back to the screen.
   *
   * Before the channel is proven there is nothing to probe — the handshake
   * deadline is already running, and it is the stricter of the two.
   */
  probe(): void {
    if (this.stopped || !this.proven) return;
    this.ping(this.options.probeTimeout ?? PROBE_TIMEOUT);
  }

  /** The phone's network changed: a socket bound to the old one is not worth testing. */
  networkChanged(): void {
    if (this.stopped) return;
    this.fail("network-changed");
  }

  /** Stop every timer. The socket is gone or being replaced. */
  stop(): void {
    this.stopped = true;
    this.options.timers.clear(this.handshakeTimer);
    this.options.timers.clear(this.pingTimer);
    this.options.timers.clear(this.pongTimer);
    this.handshakeTimer = this.pingTimer = this.pongTimer = undefined;
  }

  private schedulePing(): void {
    this.pingTimer = this.options.timers.set(() => {
      if (this.stopped) return;
      this.ping(this.options.pongTimeout ?? PONG_TIMEOUT);
      this.schedulePing();
    }, this.options.pingInterval ?? PING_INTERVAL);
  }

  private ping(deadline: number): void {
    this.options.sendPing();
    // An answer already awaited keeps its earlier deadline: a second ping does
    // not buy a dead socket more time.
    if (this.pongTimer !== undefined) return;
    this.pongTimer = this.options.timers.set(() => this.fail("no-pong"), deadline);
  }

  private clearPong(): void {
    if (this.pongTimer === undefined) return;
    this.options.timers.clear(this.pongTimer);
    this.pongTimer = undefined;
  }

  private fail(reason: ReconnectReason): void {
    if (this.stopped) return;
    this.stop();
    this.options.reconnect(reason);
  }
}
