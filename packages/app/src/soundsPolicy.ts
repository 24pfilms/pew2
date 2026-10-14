/**
 * Which sound to play, and when not to. Pure and Expo-free (tested under bun);
 * the playing is `ui/sounds.ts`, the sounds themselves `scripts/make-sounds.py`.
 */

/** Every sound the app has; one `assets/sounds/<name>.wav` each. */
export const SOUND_NAMES = [
  "charge",
  "drain",
  "burst",
  "reveal",
  "level-up-0",
  "level-up-1",
  "level-up-2",
  "level-up-3",
  "level-up-4",
  "level-down-0",
  "level-down-1",
  "level-down-2",
  "level-down-3",
  "level-down-4",
  "level-max",
  "send",
  "done",
  "attention",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

/** The level sounds come in this many pitches. */
export const LEVEL_PITCHES = 5;

/** Which of the pitches stop `index` of `count` uses: low to high across the dial. */
export function levelPitch(index: number, count: number): number {
  if (count <= 1) return Math.floor(LEVEL_PITCHES / 2);
  const f = Math.max(0, Math.min(1, index / (count - 1)));
  return Math.round(f * (LEVEL_PITCHES - 1));
}

/**
 * The sound for moving the thinking level from `from` to `to`. Up sings the
 * stop it reached (and the top gets its own flourish); down sighs from the
 * stop it left.
 */
export function levelSound(from: number, to: number, count: number): SoundName | undefined {
  if (to === from || count < 2) return undefined;
  if (to > from) return to >= count - 1 ? "level-max" : (`level-up-${levelPitch(to, count)}` as SoundName);
  return `level-down-${levelPitch(from, count)}` as SoundName;
}

/**
 * The same sound twice inside this window is one sound: a double-fired effect
 * (a reply ending and an error landing together) must not stutter.
 */
export const REPEAT_GAP_MS = 70;

export function shouldPlay(now: number, lastPlayedAt: number | undefined): boolean {
  if (lastPlayedAt === undefined || now < lastPlayedAt) return true;
  return now - lastPlayedAt >= REPEAT_GAP_MS;
}

/** Where in the charge sound to start for a hold resumed at `charge` (0..1) of `holdMs`. */
export function chargeOffsetSeconds(charge: number, holdMs: number): number {
  return (Math.max(0, Math.min(1, charge)) * holdMs) / 1000;
}
