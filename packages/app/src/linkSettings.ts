/**
 * The three switches for staying connected and ringing, and the rules they feed.
 *
 * Pure — the storage is `preferences.ts`, the native side `modules/pew-link` — so
 * every decision about whether the phone rings is a test, not a guess.
 */

export interface LinkSettings {
  /** Keep pew2 connected with the screen off (Android background service). */
  background: boolean;
  /** Ring like a call when an agent needs approval and pew2 is not on screen. */
  ringApprovals: boolean;
  /** Ring like a call when an agent finishes and pew2 is not on screen. */
  ringFinished: boolean;
}

/** On by default: being reachable away from the desk is what pew2 is for. */
export const DEFAULT_LINK_SETTINGS: LinkSettings = {
  background: true,
  ringApprovals: true,
  ringFinished: true,
};

/** Stored form, tolerant of a missing or older record: unknown fields fall back to the defaults. */
export function parseLinkSettings(raw: string | null): LinkSettings {
  if (!raw) return DEFAULT_LINK_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof LinkSettings, unknown>>;
    const pick = (key: keyof LinkSettings) =>
      typeof parsed[key] === "boolean" ? (parsed[key] as boolean) : DEFAULT_LINK_SETTINGS[key];
    return {
      background: pick("background"),
      ringApprovals: pick("ringApprovals"),
      ringFinished: pick("ringFinished"),
    };
  } catch {
    return DEFAULT_LINK_SETTINGS;
  }
}

export type RingReason = "approval" | "finished" | "callback";

/**
 * Ring, or leave it to the ordinary notification?
 *
 * Only when pew2 is not the thing on screen: someone looking at the app needs
 * no ringtone to know an agent is done, and a phone that rings while you hold it
 * would be the fastest way to get the feature switched off.
 *
 * A promised call-back ignores the switches: the user asked for that call in so
 * many words ("call me when it's done"), and a setting chosen weeks ago for
 * every finished turn is not a reason to break that promise.
 */
export function shouldRing(reason: RingReason, foreground: boolean, settings: LinkSettings): boolean {
  if (foreground) return false;
  if (reason === "callback") return true;
  return reason === "approval" ? settings.ringApprovals : settings.ringFinished;
}

/** How many approval ids are remembered, oldest forgotten first. */
const SEEN_LIMIT = 256;

/**
 * True the first time an approval id is seen.
 *
 * A reconnect restates every open request, and each must ring once, not once
 * per connection. `seen` is updated in place and bounded, so a long-running app
 * does not collect every id it has ever been asked about.
 */
export function firstSighting(seen: Set<string>, requestId: string): boolean {
  if (seen.has(requestId)) return false;
  seen.add(requestId);
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}
