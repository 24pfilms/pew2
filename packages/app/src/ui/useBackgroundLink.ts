/**
 * Keeps pew2 connected with the screen off, and brings the app back to the
 * conversation a ringing alert was answered for.
 *
 * Android only, through `modules/pew-link`; a no-op elsewhere. The service can
 * only be started while the app is on screen, so it is (re)started whenever the
 * app comes forward with the switch on — which also brings it back after the
 * user tapped "Disconnect" and later reopened pew2.
 */
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import * as PewLink from "../../modules/pew-link";

export function useBackgroundLink({
  enabled,
  title,
  resumeNow,
  onAnswered,
}: {
  /** The "Stay connected in the background" switch. */
  enabled: boolean;
  /** Shown in the ongoing notification, e.g. "pew2 · studio". */
  title: string;
  /** Check the connection now; reconnect at once if it is down. */
  resumeNow: () => void;
  /** A ring was answered: open this conversation. */
  onAnswered: (sessionId: string) => void;
}) {
  const latest = useRef({ resumeNow, onAnswered });
  latest.current = { resumeNow, onAnswered };

  // Start or stop with the switch, and re-start on coming forward: Android
  // refuses to start it from the background.
  useEffect(() => {
    if (!PewLink.available) return;
    if (!enabled) {
      PewLink.stopLink();
      return;
    }
    const ensure = () => {
      if (!PewLink.linkRunning()) {
        const started = PewLink.startLink(title, "Connected to your computer");
        console.log(`[pew2] background link ${started ? "started" : "could not start"}`);
      }
    };
    ensure();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") ensure();
    });
    return () => subscription.remove();
  }, [enabled, title]);

  // The service's clock. JavaScript timers are paused with the screen off, so
  // a dropped socket would otherwise wait for the app to be opened to retry.
  useEffect(() => {
    if (!PewLink.available || !enabled) return;
    const tick = PewLink.onTick(() => latest.current.resumeNow());
    const stopped = PewLink.onStopped(() => console.log("[pew2] background link stopped from notification"));
    return () => {
      tick.remove();
      stopped.remove();
    };
  }, [enabled]);

  // Coming forward ends any ringing, and opens the conversation a ring was
  // answered for — on a cold start as well as a warm one.
  useEffect(() => {
    if (!PewLink.available) return;
    const collect = () => {
      PewLink.cancelAllRings();
      const sessionId = PewLink.takeAnswered();
      if (sessionId) latest.current.onAnswered(sessionId);
    };
    collect();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") collect();
    });
    return () => subscription.remove();
  }, []);
}
