/**
 * Banners for finished turns: whether the app is on screen, whether the daemon
 * will push instead, and what the user did with a banner.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { TurnFinished } from "../useDaemon";
import { finishedNotice } from "../notificationPolicy";
import { notify, onNotificationChoice, type NotificationChoice } from "./notifier";

export function useTurnBanners() {
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
   * five-minute turn is only discovered by going back to check.
   */
  const announceTurn = useCallback((turn: TurnFinished) => {
    const notice = finishedNotice({
      ...turn,
      foreground: foreground.current,
      pushExpected: pushExpected.current,
    });
    if (notice) void notify(notice);
  }, []);

  return { choice, setChoice, pushExpected, announceTurn };
}
