/**
 * Banners for finished turns: whether the app is on screen, whether the daemon
 * will push instead, and what the user did with a banner.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { AppState } from "react-native";
import type { TurnFinished } from "../useDaemon";
import { finishedNotice } from "../notificationPolicy";
import { notify, onNotificationChoice, type NotificationChoice } from "./notifier";
import { firstSighting, shouldRing, type LinkSettings } from "../linkSettings";
import * as PewLink from "../../modules/pew-link";

/**
 * @param linkSettings The background-link and ringing switches, read when
 *   something happens rather than captured, so changing one never rebuilds
 *   the callbacks the socket handler holds.
 * @param voiceOffered Whether the computer can host a call with Orca right
 *   now, so a ring can be answered by talking. Read the same way.
 */
export function useTurnBanners(linkSettings: RefObject<LinkSettings>, voiceOffered: RefObject<boolean>) {
  // Whether the app is the thing on screen. A ref, not state: it is read when a
  // turn finishes, and re-rendering the whole screen because the app was
  // backgrounded would be work nobody can see.
  const foreground = useRef(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      foreground.current = next === "active";
    });
    return () => subscription.remove();
  }, []);

  // What the user did with a banner, held until it can be acted on. Both a tap
  // and an inline reply can launch the app cold, and the session list arrives
  // over the socket seconds later.
  const [choice, setChoice] = useState<NotificationChoice | undefined>(undefined);
  useEffect(() => onNotificationChoice(setChoice), []);

  // Whether the daemon has somewhere to push.
  //
  // What stops a backgrounded Android phone announcing the same turn twice:
  // there the socket outlives the app leaving the screen, so `session.idle`
  // still arrives and both routes would fire. Driven by the daemon accepting
  // the token rather than this app merely holding one — an older daemon refuses
  // `app.push`, and suppressing the local banner for a push that can never come
  // would leave the phone silent.
  const pushExpected = useRef(false);

  /**
   * Announce a turn that ended somewhere the user cannot see it.
   *
   * The agent runs on the desktop and keeps running when this app is
   * backgrounded or looking at another project, so without this a finished
   * five-minute turn is only discovered by going back to check. With the app
   * off screen it rings like a call, unless that is switched off; a ring that
   * cannot be raised still leaves the ordinary notification.
   */
  const announceTurn = useCallback((turn: TurnFinished) => {
    const ringing = shouldRing("finished", foreground.current, linkSettings.current);
    const notice = finishedNotice({
      ...turn,
      foreground: foreground.current,
      // A push would stand in for the local banner, but not for the ring: with
      // the app off screen and a push registered, the turn was announced by a
      // quiet banner only and the phone never rang. The push stays the backup
      // for when the app is not running at all.
      pushExpected: ringing ? false : pushExpected.current,
    });
    if (!notice) return;
    if (ringing) {
      const rang = PewLink.ring(
        `turn:${notice.sessionId}:${Date.now()}`,
        notice.title,
        notice.body,
        notice.sessionId,
        voiceOffered.current,
      );
      if (rang) return;
      console.warn("[pew2] could not ring for a finished turn; notifying instead");
    }
    void notify(notice);
  }, [linkSettings, voiceOffered]);

  /**
   * An agent somewhere is blocked on an approval. With the app off screen it
   * rings, because nothing else will tell anyone and the agent waits until
   * then. Each request rings once: a reconnect restates every open one.
   */
  const seenApprovals = useRef(new Set<string>());
  const announceApproval = useCallback(
    (approval: { requestId: string; sessionId: string; title: string }) => {
      if (!firstSighting(seenApprovals.current, approval.requestId)) return;
      if (!shouldRing("approval", foreground.current, linkSettings.current)) return;
      const rang = PewLink.ring(
        `approval:${approval.requestId}`,
        "Approval needed",
        approval.title,
        approval.sessionId,
        voiceOffered.current,
      );
      if (rang) return;
      console.warn("[pew2] could not ring for an approval; notifying instead");
      void notify({ title: "Approval needed", body: approval.title, sessionId: approval.sessionId });
    },
    [linkSettings, voiceOffered],
  );

  return { choice, setChoice, pushExpected, announceTurn, announceApproval };
}
