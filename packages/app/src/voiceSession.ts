/**
 * The live voice conversation, as data.
 *
 * Pure and Expo-free so `bun test` can load it: the peer connection, the mic
 * and audio routing live in `ui/useVoice.ts`, which feeds this reducer events
 * and renders what it returns.
 *
 * Captions come from GPT-Live transcript deltas. The model is full duplex and
 * sends no turn-end event, so the user's and the assistant's lines grow
 * independently and a line is closed only by a pause from that speaker.
 */

export type VoicePhase = "idle" | "connecting" | "live" | "ending" | "error";
export type Speaker = "user" | "assistant";

export interface Caption {
  id: number;
  speaker: Speaker;
  text: string;
  /** Clock reading of the last fragment, used to decide when a line ends. */
  updatedAt: number;
}

/** The daemon's `voice.status`, as far as this module reads it. */
export interface VoiceStatusFrame {
  liveSessionId: string;
  state: "ready" | "agent_working" | "agent_waiting" | "agent_done" | "closed" | "error";
  sessionId?: string;
  providerId?: string;
  folder?: string;
  detail?: string;
}

export interface VoiceState {
  phase: VoicePhase;
  /** The `voice.start` this phone sent and is waiting on. */
  requestId?: string;
  /** Assigned by the daemon in `voice.answer`. Statuses for any other id are ignored. */
  liveSessionId?: string;
  muted: boolean;
  captions: Caption[];
  nextCaptionId: number;
  /** The latest agent status for this call, if the assistant handed work over. */
  agent?: VoiceStatusFrame;
  error?: string;
  /** Last assistant transcript fragment, standing in for "is speaking". */
  assistantAt?: number;
  /** When the assistant picked up, for the elapsed-time line. */
  liveSince?: number;
  /** Per-minute rate from `voice.answer`, for the running cost estimate. */
  voiceRatePerMinuteUsd?: number;
  /**
   * Full screen or shrunk to the banner. The call keeps running either way;
   * this only decides which UI is up, so the user can watch the agent's work
   * in the chat underneath without hanging up.
   */
  minimized: boolean;
}

export type VoiceEvent =
  | { type: "start"; requestId: string }
  | { type: "answer"; requestId: string; liveSessionId?: string; voiceRatePerMinuteUsd?: number; error?: string }
  | { type: "started"; now: number }
  | { type: "transcript"; speaker: Speaker; delta: string; now: number }
  | { type: "status"; status: VoiceStatusFrame }
  | { type: "mute"; muted: boolean }
  | { type: "minimize" }
  | { type: "expand" }
  | { type: "end" }
  | { type: "closed" }
  | { type: "fail"; message: string }
  | { type: "reset" };

/** A pause longer than this from one speaker starts a new caption line. */
export const CAPTION_GAP_MS = 2500;
/** How many caption lines are kept; the screen shows only the last few. */
export const MAX_CAPTIONS = 6;
/** How long after the last assistant fragment it still counts as speaking. */
export const SPEAKING_WINDOW_MS = 1200;
/**
 * How loud Orca is on the phone, as a gain on her incoming voice (1 is how the
 * call arrives, 0 is silent). She came through too loud at 1. Loudness is heard
 * on a log scale: halving the gain only takes off about a third of what is
 * heard, and about 0.35 (9 dB down) is what sounds half as loud. The phone's
 * own volume buttons still work on top of this.
 */
export const ORCA_VOICE_GAIN = 0.35;

export const initialVoiceState: VoiceState = {
  phase: "idle",
  muted: false,
  captions: [],
  nextCaptionId: 1,
  minimized: false,
};

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "start":
      if (state.phase === "connecting" || state.phase === "live" || state.phase === "ending") return state;
      return { ...initialVoiceState, phase: "connecting", requestId: event.requestId };

    case "answer":
      if (state.phase !== "connecting" || event.requestId !== state.requestId) return state;
      if (event.error || !event.liveSessionId) {
        return { ...state, phase: "error", error: event.error ?? "The computer did not start the conversation." };
      }
      return { ...state, liveSessionId: event.liveSessionId, voiceRatePerMinuteUsd: event.voiceRatePerMinuteUsd };

    case "started":
      return state.phase === "connecting" ? { ...state, phase: "live", liveSince: event.now } : state;

    case "transcript":
      if (state.phase !== "live" && state.phase !== "connecting") return state;
      if (!event.delta) return state;
      return {
        ...state,
        captions: appendCaption(state, event.speaker, event.delta, event.now),
        nextCaptionId: state.nextCaptionId + 1,
        assistantAt: event.speaker === "assistant" ? event.now : state.assistantAt,
      };

    case "status": {
      const status = event.status;
      if (!state.liveSessionId || status.liveSessionId !== state.liveSessionId) return state;
      if (status.state === "closed") return state.phase === "idle" ? state : { ...state, phase: "idle", agent: undefined };
      if (status.state === "error") {
        // Errors force the screen back up: a buried error is never read.
        return { ...state, phase: "error", error: status.detail ?? "The voice conversation stopped.", minimized: false };
      }
      if (status.state === "ready") return state;
      return { ...state, agent: status };
    }

    case "mute":
      return { ...state, muted: event.muted };

    case "minimize":
      return state.phase === "connecting" || state.phase === "live" ? { ...state, minimized: true } : state;

    case "expand":
      return state.minimized ? { ...state, minimized: false } : state;

    case "end":
      return state.phase === "idle" || state.phase === "error" ? state : { ...state, phase: "ending" };

    case "closed":
      return { ...state, phase: "idle" };

    case "fail":
      return state.phase === "idle" ? state : { ...state, phase: "error", error: event.message, minimized: false };

    case "reset":
      return initialVoiceState;
  }
}

/**
 * Add one fragment exactly as received.
 *
 * Continues the speaker's most recent line while it is fresh, even if the other
 * speaker talked in between: that is what full duplex looks like, and starting
 * a new line on every interjection would shred both sentences.
 */
function appendCaption(state: VoiceState, speaker: Speaker, delta: string, now: number): Caption[] {
  const captions = state.captions;
  for (let index = captions.length - 1; index >= 0; index--) {
    const caption = captions[index];
    if (!caption || caption.speaker !== speaker) continue;
    if (now - caption.updatedAt > CAPTION_GAP_MS) break;
    const next = captions.slice();
    next[index] = { ...caption, text: caption.text + delta, updatedAt: now };
    return next;
  }
  const line: Caption = { id: state.nextCaptionId, speaker, text: delta.trimStart(), updatedAt: now };
  return [...captions, line].slice(-MAX_CAPTIONS);
}

export type VoiceOrb = "connecting" | "listening" | "speaking" | "working" | "muted" | "idle";

/** What the central orb should show. `now` is injected so this stays testable. */
export function voiceOrb(state: VoiceState, now: number): VoiceOrb {
  if (state.phase === "connecting" || state.phase === "ending") return "connecting";
  if (state.phase !== "live") return "idle";
  if (state.assistantAt !== undefined && now - state.assistantAt < SPEAKING_WINDOW_MS) return "speaking";
  if (state.agent?.state === "agent_working" || state.agent?.state === "agent_waiting") return "working";
  return state.muted ? "muted" : "listening";
}

/**
 * The line under the orb.
 *
 * The agent's state wins over the call's own, because "Claude Code needs your
 * approval" is the one thing on this screen the user may have to act on.
 */
export function voiceStatusLine(state: VoiceState, providerName: (id: string | undefined) => string): string {
  if (state.phase === "error") return state.error ?? "The voice conversation stopped.";
  if (state.phase === "connecting") return "Connecting";
  if (state.phase === "ending") return "Ending the conversation";
  if (state.phase === "idle") return "";
  const agent = state.agent;
  if (agent) {
    const name = providerName(agent.providerId);
    const where = agent.folder ? ` in ${agent.folder}` : "";
    if (agent.state === "agent_working") return `${name} is working${where}`;
    if (agent.state === "agent_waiting") return `${name} needs your approval`;
    if (agent.state === "agent_done") return `${name} finished${where}`;
  }
  return state.muted ? "Muted" : "Listening";
}

/**
 * The quiet line under the status while a call is live: elapsed time, and a
 * running cost estimate when the daemon named the rate. "About", because the
 * delegation turns add a little that this cannot see.
 */
export function voiceUsageLine(state: VoiceState, now: number): string {
  if (state.phase !== "live" || state.liveSince === undefined) return "";
  const seconds = Math.max(0, Math.floor((now - state.liveSince) / 1000));
  const minutes = Math.floor(seconds / 60);
  const clock = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  const rate = state.voiceRatePerMinuteUsd;
  if (rate === undefined) return clock;
  const costUsd = (seconds / 60) * rate;
  // The rate is in US dollars (OpenAI bills in them), so the estimate is too.
  const cost = costUsd < 1 ? `${Math.round(costUsd * 100)}¢` : `$${costUsd.toFixed(2)}`;
  return `${clock} · about ${cost}`;
}

/**
 * Whether a finished turn should ring the phone like an incoming call.
 *
 * The turn must be one nobody is watching. The conversation on screen
 * finishing is visible already, and ringing over it is the intrusiveness this
 * feature is meant to avoid being, but only while the app is actually in
 * front: "on screen" is app state, and it stays set with the phone locked in a
 * pocket, which is exactly the hang-up-and-call-me-back case. So a
 * backgrounded app rings for every conversation. `appActive` absent means
 * "unknown" and keeps the on-screen rule.
 */
export function shouldRingForTurn(
  turn: { sessionId: string; appActive?: boolean },
  opts: { onScreen?: string; callActive: boolean },
): boolean {
  if (opts.callActive) return false;
  if (turn.appActive === false) return true;
  return turn.sessionId !== opts.onScreen;
}

/**
 * The conversation a status points at, if the app should move to it.
 *
 * Only for this phone's own call, and only when it is not already on screen,
 * so hanging up leaves the user looking at the work.
 */
export function voiceSessionToOpen(status: VoiceStatusFrame, liveSessionId: string | undefined, onScreen: string | undefined): string | undefined {
  if (!liveSessionId || status.liveSessionId !== liveSessionId) return undefined;
  if (!status.sessionId || status.sessionId === onScreen) return undefined;
  return status.sessionId;
}

/** Read one GPT-Live data-channel event, ignoring anything unrecognised. */
export type DataChannelEvent =
  | { kind: "started" }
  | { kind: "transcript"; speaker: Speaker; delta: string }
  | { kind: "error"; message: string }
  | { kind: "closed" };

export function readDataChannelEvent(raw: string): DataChannelEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as { type?: unknown; delta?: unknown; error?: unknown; message?: unknown };
  switch (event.type) {
    case "session.started":
      return { kind: "started" };
    case "session.closed":
      return { kind: "closed" };
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      if (typeof event.delta !== "string") return undefined;
      return {
        kind: "transcript",
        speaker: event.type === "session.input_transcript.delta" ? "user" : "assistant",
        delta: event.delta,
      };
    case "error": {
      const nested = typeof event.error === "object" && event.error !== null ? (event.error as { message?: unknown }).message : undefined;
      const message = typeof nested === "string" ? nested : typeof event.message === "string" ? event.message : "The voice service reported an error.";
      return { kind: "error", message };
    }
    default:
      return undefined;
  }
}
