import { describe, expect, test } from "bun:test";
import {
  CAPTION_GAP_MS,
  initialVoiceState,
  readDataChannelEvent,
  shouldRingForTurn,
  voiceOrb,
  voiceReducer,
  voiceSessionToOpen,
  voiceStatusLine,
  voiceUsageLine,
  type VoiceEvent,
  type VoiceState,
} from "./voiceSession";

const run = (events: VoiceEvent[], from: VoiceState = initialVoiceState) => events.reduce(voiceReducer, from);
const live = run([
  { type: "start", requestId: "r1" },
  { type: "answer", requestId: "r1", liveSessionId: "L1" },
  { type: "started", now: 0 },
]);
const names = (id: string | undefined) => (id === "claude" ? "Claude Code" : "Your agent");

describe("voice state machine", () => {
  test("idle to connecting to live to ending to idle", () => {
    const connecting = run([{ type: "start", requestId: "r1" }]);
    expect(connecting.phase).toBe("connecting");
    const answered = voiceReducer(connecting, { type: "answer", requestId: "r1", liveSessionId: "L1" });
    expect(answered.phase).toBe("connecting");
    expect(answered.liveSessionId).toBe("L1");
    expect(live.phase).toBe("live");
    const ending = voiceReducer(live, { type: "end" });
    expect(ending.phase).toBe("ending");
    expect(voiceReducer(ending, { type: "closed" }).phase).toBe("idle");
  });

  test("an answer for another request is ignored", () => {
    const state = run([{ type: "start", requestId: "r1" }, { type: "answer", requestId: "r2", liveSessionId: "X" }]);
    expect(state.liveSessionId).toBeUndefined();
  });

  test("an answer with an error fails the call", () => {
    const state = run([{ type: "start", requestId: "r1" }, { type: "answer", requestId: "r1", error: "No OpenAI key" }]);
    expect(state.phase).toBe("error");
    expect(voiceStatusLine(state, names)).toBe("No OpenAI key");
  });

  test("a second start while live does nothing", () => {
    expect(voiceReducer(live, { type: "start", requestId: "r9" })).toBe(live);
  });
});

describe("captions", () => {
  test("fragments append exactly and speakers grow independently", () => {
    const state = run([
      { type: "transcript", speaker: "user", delta: "Can you", now: 0 },
      { type: "transcript", speaker: "assistant", delta: "Sure", now: 100 },
      { type: "transcript", speaker: "user", delta: " fix it", now: 200 },
      { type: "transcript", speaker: "assistant", delta: ", on it.", now: 300 },
    ], live);
    expect(state.captions.map((c) => [c.speaker, c.text])).toEqual([
      ["user", "Can you fix it"],
      ["assistant", "Sure, on it."],
    ]);
  });

  test("a pause starts a new line", () => {
    const state = run([
      { type: "transcript", speaker: "user", delta: "One.", now: 0 },
      { type: "transcript", speaker: "user", delta: " Two.", now: CAPTION_GAP_MS + 1 },
    ], live);
    expect(state.captions.map((c) => c.text)).toEqual(["One.", "Two."]);
  });

  test("only the last few lines are kept", () => {
    const events: VoiceEvent[] = Array.from({ length: 10 }, (_, i) => ({ type: "transcript", speaker: "user", delta: `${i}`, now: i * 10_000 }));
    const state = run(events, live);
    expect(state.captions).toHaveLength(6);
    expect(state.captions.at(-1)?.text).toBe("9");
  });
});

describe("status", () => {
  test("minimise and expand only move the screen, never the call", () => {
    expect(live.minimized).toBe(false);
    const minimised = voiceReducer(live, { type: "minimize" });
    expect(minimised.minimized).toBe(true);
    expect(minimised.phase).toBe("live");
    // A transcript still lands while minimised: the call is untouched.
    const talked = voiceReducer(minimised, { type: "transcript", speaker: "assistant", delta: "Still here.", now: 1000 });
    expect(talked.captions.at(-1)?.text).toBe("Still here.");
    expect(talked.minimized).toBe(true);
    expect(voiceReducer(talked, { type: "expand" }).minimized).toBe(false);
    // Idle ignores both.
    expect(voiceReducer(initialVoiceState, { type: "minimize" })).toBe(initialVoiceState);
    expect(voiceReducer(initialVoiceState, { type: "expand" })).toBe(initialVoiceState);
  });

  test("a failure pulls the screen back up", () => {
    const minimised = voiceReducer(live, { type: "minimize" });
    const failed = voiceReducer(minimised, { type: "fail", message: "The voice connection dropped." });
    expect(failed.phase).toBe("error");
    expect(failed.minimized).toBe(false);
    const statusFailed = voiceReducer(minimised, {
      type: "status",
      status: { liveSessionId: "L1", state: "error", detail: "boom" },
    });
    expect(statusFailed.minimized).toBe(false);
  });

  test("a new call always starts full screen", () => {
    const minimised = voiceReducer(live, { type: "minimize" });
    const ended = voiceReducer(voiceReducer(minimised, { type: "end" }), { type: "closed" });
    const restarted = voiceReducer(ended, { type: "start", requestId: "r2" });
    expect(restarted.minimized).toBe(false);
  });

  test("the usage line is a clock, plus an estimate when the rate is known", () => {
    expect(voiceUsageLine(initialVoiceState, 10_000)).toBe("");
    const connecting = run([{ type: "start", requestId: "r1" }]);
    expect(voiceUsageLine(connecting, 10_000)).toBe("");
    // No rate from the daemon: just the clock.
    expect(voiceUsageLine(live, 0)).toBe("0:00");
    expect(voiceUsageLine(live, 65_000)).toBe("1:05");
    const rated = voiceReducer(run([{ type: "start", requestId: "r1" }]), {
      type: "answer", requestId: "r1", liveSessionId: "L1", voiceRatePerMinuteUsd: 0.05,
    });
    const ratedLive = voiceReducer(rated, { type: "started", now: 0 });
    expect(voiceUsageLine(ratedLive, 60_000)).toBe("1:00 · about 5¢");
    expect(voiceUsageLine(ratedLive, 30 * 60_000)).toBe("30:00 · about $1.50");
  });

  test("a turn rings only when nobody is watching it and no call is live", () => {
    expect(shouldRingForTurn({ sessionId: "s1" }, { onScreen: "s2", callActive: false })).toBe(true);
    expect(shouldRingForTurn({ sessionId: "s1" }, { onScreen: "s1", callActive: false })).toBe(false);
    expect(shouldRingForTurn({ sessionId: "s1" }, { onScreen: undefined, callActive: false })).toBe(true);
    expect(shouldRingForTurn({ sessionId: "s1" }, { onScreen: "s2", callActive: true })).toBe(false);
  });

  test("a backgrounded app rings even for the conversation left on screen", () => {
    // Phone in a pocket: the conversation is still "on screen" in app state.
    expect(shouldRingForTurn({ sessionId: "s1", appActive: false }, { onScreen: "s1", callActive: false })).toBe(true);
    // In front and looking at it: no ring, it is visible already.
    expect(shouldRingForTurn({ sessionId: "s1", appActive: true }, { onScreen: "s1", callActive: false })).toBe(false);
    // A live call still wins over everything.
    expect(shouldRingForTurn({ sessionId: "s1", appActive: false }, { onScreen: "s1", callActive: true })).toBe(false);
  });

  test("statuses for another call are ignored", () => {
    const state = voiceReducer(live, { type: "status", status: { liveSessionId: "other", state: "agent_working" } });
    expect(state).toBe(live);
  });

  test("maps agent states to a status line", () => {
    const working = voiceReducer(live, { type: "status", status: { liveSessionId: "L1", state: "agent_working", providerId: "claude", folder: "pew2" } });
    expect(voiceStatusLine(working, names)).toBe("Claude Code is working in pew2");
    expect(voiceOrb(working, 0)).toBe("working");
    const waiting = voiceReducer(live, { type: "status", status: { liveSessionId: "L1", state: "agent_waiting", providerId: "claude" } });
    expect(voiceStatusLine(waiting, names)).toBe("Claude Code needs your approval");
    const done = voiceReducer(live, { type: "status", status: { liveSessionId: "L1", state: "agent_done", providerId: "claude", folder: "pew2" } });
    expect(voiceStatusLine(done, names)).toBe("Claude Code finished in pew2");
  });

  test("closed and error from the daemon end the call", () => {
    expect(voiceReducer(live, { type: "status", status: { liveSessionId: "L1", state: "closed" } }).phase).toBe("idle");
    const failed = voiceReducer(live, { type: "status", status: { liveSessionId: "L1", state: "error", detail: "Key rejected" } });
    expect(voiceStatusLine(failed, names)).toBe("Key rejected");
  });

  test("listening, muted and speaking", () => {
    expect(voiceStatusLine(live, names)).toBe("Listening");
    expect(voiceStatusLine(voiceReducer(live, { type: "mute", muted: true }), names)).toBe("Muted");
    const speaking = voiceReducer(live, { type: "transcript", speaker: "assistant", delta: "Hi", now: 1000 });
    expect(voiceOrb(speaking, 1500)).toBe("speaking");
    expect(voiceOrb(speaking, 5000)).toBe("listening");
  });

  test("switches only to a conversation of this call that is not on screen", () => {
    const status = { liveSessionId: "L1", state: "agent_working" as const, sessionId: "s2" };
    expect(voiceSessionToOpen(status, "L1", "s1")).toBe("s2");
    expect(voiceSessionToOpen(status, "L1", "s2")).toBeUndefined();
    expect(voiceSessionToOpen(status, "L9", "s1")).toBeUndefined();
  });
});

describe("data channel events", () => {
  test("reads the events the call uses", () => {
    expect(readDataChannelEvent('{"type":"session.started"}')).toEqual({ kind: "started" });
    expect(readDataChannelEvent('{"type":"session.output_transcript.delta","delta":"hi","start_ms":1,"end_ms":2}')).toEqual({ kind: "transcript", speaker: "assistant", delta: "hi" });
    expect(readDataChannelEvent('{"type":"session.input_transcript.delta","delta":"yo"}')).toEqual({ kind: "transcript", speaker: "user", delta: "yo" });
    expect(readDataChannelEvent('{"type":"error","error":{"message":"bad"}}')).toEqual({ kind: "error", message: "bad" });
    expect(readDataChannelEvent('{"type":"session.closed"}')).toEqual({ kind: "closed" });
    expect(readDataChannelEvent("not json")).toBeUndefined();
    expect(readDataChannelEvent('{"type":"something.else"}')).toBeUndefined();
  });
});
