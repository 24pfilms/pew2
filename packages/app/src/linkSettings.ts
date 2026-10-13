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

export type RingReason = "approval" | "finished";

/**
 * Ring, or leave it to the ordinary notification?
 *
 * Only when pew2 is not the thing on screen: someone looking at the app needs
 * no ringtone to know an agent is done, and a phone that rings while you hold it
 * would be the fastest way to get the feature switched off.
 */
export function shouldRing(reason: RingReason, foreground: boolean, settings: LinkSettings): boolean {
  if (foreground) return false;
  return reason === "approval" ? settings.ringApprovals : settings.ringFinished;
}

export interface PendingApproval {
  requestId: string;
  sessionId: string;
  title: string;
}

/**
 * Approval requests not seen before, given every one open right now.
 *
 * `seen` is updated in place and pruned to what is still open, so a request
 * answered and later re-asked under the same id would ring again — and the set
 * never grows past the requests actually waiting.
 */
export function newApprovals(
  seen: Set<string>,
  open: readonly PendingApproval[],
): PendingApproval[] {
  const fresh = open.filter((approval) => !seen.has(approval.requestId));
  const stillOpen = new Set(open.map((approval) => approval.requestId));
  for (const id of seen) if (!stillOpen.has(id)) seen.delete(id);
  for (const approval of fresh) seen.add(approval.requestId);
  return fresh;
}
