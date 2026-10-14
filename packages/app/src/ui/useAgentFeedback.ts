/**
 * Haptics and sounds for what the agent does on its own.
 */
import { useEffect, useRef } from "react";
import { Keyboard } from "react-native";
import type { PermissionRequest, Turn } from "../useDaemon";
import { haptics } from "./haptics";
import { sounds } from "./sounds";

export function useAgentFeedback(
  busy: boolean,
  turns: readonly Turn[],
  permission: PermissionRequest | undefined,
) {
  // Feedback for things that happen on their own, rather than because a finger
  // touched the screen. This is the point of a remote control: the agent runs
  // for minutes on another machine, and the phone is usually in a pocket. Each
  // effect compares against the previous value so nothing fires on mount.

  // A turn landed. The single most useful pulse in the app.
  const wasBusy = useRef(false);
  useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!finished) return;
    // A turn that ended in an error already pulsed as a failure below; a success
    // buzz on top of it would contradict what the screen says.
    const last = turns[turns.length - 1];
    if (last?.role !== "system") {
      haptics.finished();
      sounds.play("done");
    }
  }, [busy, turns]);

  // The agent is blocked on an approval and cannot continue without one.
  const lastPermissionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const requestId = permission?.requestId;
    if (requestId && requestId !== lastPermissionId.current) {
      Keyboard.dismiss();
      haptics.attention();
      sounds.play("attention");
    }
    lastPermissionId.current = requestId;
  }, [permission]);

  // Something failed. Keyed by role as well as id, because a duplicated error is
  // promoted in place rather than appended, which leaves the id unchanged.
  const lastTurnKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const last = turns[turns.length - 1];
    const key = last && `${last.id}:${last.role}`;
    const changed = key !== undefined && key !== lastTurnKey.current;
    // Seed on first render so an error already on screen from a replayed
    // session does not buzz every time the component mounts.
    const seeded = lastTurnKey.current !== undefined;
    lastTurnKey.current = key;
    if (seeded && changed && last?.role === "system") haptics.failed();
  }, [turns]);
}
