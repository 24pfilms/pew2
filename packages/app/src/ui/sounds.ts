/**
 * Sound effects, named by moment like `haptics.ts`. The rules (which sound,
 * when not to) live in `soundsPolicy.ts`; the sounds are made by
 * `scripts/make-sounds.py`.
 *
 * Polite by construction: the audio session is "ambient", so the ring/silent
 * switch mutes every sound, and it mixes with whatever is already playing
 * (a podcast keeps going under a reply chime). Nothing plays while dictating:
 * the recogniser is listening, and a chime would end up in the transcript.
 *
 * Like haptics, sound is decoration: failures are swallowed and nothing waits
 * on a sound.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { chargeOffsetSeconds, shouldPlay, type SoundName } from "../soundsPolicy";

// Metro resolves asset `require`s at bundle time; an `import` of a .wav has no
// type here, so these stay requires.
/* eslint-disable @typescript-eslint/no-require-imports */
const SOURCES: Record<SoundName, number> = {
  charge: require("../../assets/sounds/charge.wav"),
  drain: require("../../assets/sounds/drain.wav"),
  burst: require("../../assets/sounds/burst.wav"),
  reveal: require("../../assets/sounds/reveal.wav"),
  "level-up-0": require("../../assets/sounds/level-up-0.wav"),
  "level-up-1": require("../../assets/sounds/level-up-1.wav"),
  "level-up-2": require("../../assets/sounds/level-up-2.wav"),
  "level-up-3": require("../../assets/sounds/level-up-3.wav"),
  "level-up-4": require("../../assets/sounds/level-up-4.wav"),
  "level-down-0": require("../../assets/sounds/level-down-0.wav"),
  "level-down-1": require("../../assets/sounds/level-down-1.wav"),
  "level-down-2": require("../../assets/sounds/level-down-2.wav"),
  "level-down-3": require("../../assets/sounds/level-down-3.wav"),
  "level-down-4": require("../../assets/sounds/level-down-4.wav"),
  "level-max": require("../../assets/sounds/level-max.wav"),
  send: require("../../assets/sounds/send.wav"),
  done: require("../../assets/sounds/done.wav"),
  attention: require("../../assets/sounds/attention.wav"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

const players = new Map<SoundName, AudioPlayer>();
const lastPlayed = new Map<SoundName, number>();
const fades = new Map<SoundName, ReturnType<typeof setInterval>>();
let mode: Promise<void> | undefined;
let listening = false;

/** Ambient, mixing, muted by the silent switch. Re-applied after dictation took the session. */
function ensureMode(): void {
  mode ??= setAudioModeAsync({
    playsInSilentMode: false,
    interruptionMode: "mixWithOthers",
    allowsRecording: false,
    shouldPlayInBackground: false,
  }).catch(() => {});
}

function player(name: SoundName): AudioPlayer | undefined {
  let p = players.get(name);
  if (!p) {
    try {
      p = createAudioPlayer(SOURCES[name]);
      players.set(name, p);
    } catch {
      return undefined;
    }
  }
  return p;
}

function clearFade(name: SoundName): void {
  const f = fades.get(name);
  if (f) clearInterval(f);
  fades.delete(name);
}

export const sounds = {
  /** Load these now, so the first play is not late (a screen that is about to need them). */
  preload(names: readonly SoundName[]): void {
    ensureMode();
    for (const name of names) player(name);
  },

  /** Play from the start, or from `at` seconds in. */
  play(name: SoundName, at = 0): void {
    if (listening) return;
    const now = Date.now();
    if (!shouldPlay(now, lastPlayed.get(name))) return;
    lastPlayed.set(name, now);
    ensureMode();
    const p = player(name);
    if (!p) return;
    try {
      clearFade(name);
      p.volume = 1;
      void p.seekTo(at).catch(() => {});
      p.play();
    } catch {
      // Decoration only.
    }
  },

  /** The hold's charge, picked up where a released hold left it. */
  charge(charge: number, holdMs: number): void {
    sounds.play("charge", chargeOffsetSeconds(charge, holdMs));
  },

  /** Fade a playing sound out over `ms` (a released hold). */
  stop(name: SoundName, ms = 80): void {
    const p = players.get(name);
    if (!p) return;
    clearFade(name);
    const steps = Math.max(1, Math.round(ms / 16));
    let k = 0;
    const from = p.volume;
    fades.set(
      name,
      setInterval(() => {
        k++;
        try {
          p.volume = Math.max(0, from * (1 - k / steps));
          if (k >= steps) {
            clearFade(name);
            p.pause();
            p.volume = 1;
          }
        } catch {
          clearFade(name);
        }
      }, 16),
    );
  },

  /**
   * Dictation owns the audio session while it listens: stay quiet, and take
   * the session back afterwards (the recogniser leaves it set for recording,
   * which plays through the earpiece).
   */
  setListening(on: boolean): void {
    listening = on;
    if (!on) mode = undefined;
  },
};
