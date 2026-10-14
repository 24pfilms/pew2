/**
 * Development-only automation for the main screen. Every hook here is a no-op
 * unless `__DEV__` and its `EXPO_PUBLIC_DEV_*` variable are both set, so a
 * simulator check can be filmed or screenshotted without a tap.
 */
import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Keyboard } from "react-native";
import type { ComposerDockHandle } from "./ui/ComposerDock";
import type { DrawerRow } from "./historyMetadata";

type Setter<T> = Dispatch<SetStateAction<T>>;

export function useDevKeyboardLoop(composer: RefObject<ComposerDockHandle | null>) {
  // `EXPO_PUBLIC_DEV_KEYBOARD_LOOP=1` (development only): focus the composer
  // at 8s, put the keyboard away at 11s, again every 6s, so the keyboard's
  // entrance can be filmed and measured frame by frame without a tap.
  useEffect(() => {
    if (!__DEV__ || process.env.EXPO_PUBLIC_DEV_KEYBOARD_LOOP !== "1") return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let k = 0; k < 4; k++) {
      timers.push(setTimeout(() => composer.current?.focus(), 8000 + k * 6000));
      timers.push(setTimeout(() => Keyboard.dismiss(), 11000 + k * 6000));
    }
    return () => timers.forEach(clearTimeout);
  }, [composer]);
}

export function useDevOpenSession({
  rows,
  activeId,
  openSession,
  startNewChat,
  setNewChatOpen,
}: {
  rows: readonly DrawerRow[];
  activeId: string | undefined;
  openSession: (id: string) => void;
  startNewChat: (cwd?: string) => void;
  setNewChatOpen: Setter<boolean>;
}) {
  // `EXPO_PUBLIC_DEV_OPEN_SESSION=<n>` (development only): open the n-th chat
  // in the drawer 6s after launch, leave it at 16s and open it again at 20s,
  // so opening a chat (cold, then already loaded) can be filmed on the
  // simulator without a tap.
  const devOpen = __DEV__ ? process.env.EXPO_PUBLIC_DEV_OPEN_SESSION : undefined;
  const devOpenRows = useRef(rows);
  devOpenRows.current = rows;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  useEffect(() => {
    if (devOpen === undefined) return;
    const n = Number(devOpen) || 0;
    const open = () => {
      // A numeric value is an index into this agent's chats; anything else is
      // a session id (for opening one specific long conversation).
      const row = /^\d+$/.test(devOpen)
        ? devOpenRows.current.filter((r) => r.providerId === activeIdRef.current)[n]
        : devOpenRows.current.find((r) => r.id === devOpen);
      if (row) openSession(row.id);
      else if (!/^\d+$/.test(devOpen)) openSession(devOpen);
    };
    // `EXPO_PUBLIC_DEV_NEWCHAT_PROBE=1`: from inside the open chat, open the
    // New chat sheet at 10s and start the new chat at 14s, logging when each
    // was asked for, so its timing can be read off a recording.
    if (process.env.EXPO_PUBLIC_DEV_NEWCHAT_PROBE === "1") {
      const probe = [
        setTimeout(open, 6000),
        setTimeout(() => {
          console.log("NC-PROBE open-sheet", Date.now() % 100000);
          setNewChatOpen(true);
        }, 10000),
        setTimeout(() => {
          console.log("NC-PROBE start", Date.now() % 100000);
          startNewChat();
        }, 14000),
      ];
      return () => probe.forEach(clearTimeout);
    }
    const timers = [setTimeout(open, 6000), setTimeout(() => startNewChat(), 16000), setTimeout(open, 20000)];
    return () => timers.forEach(clearTimeout);
  }, [devOpen, openSession, startNewChat, setNewChatOpen]);
}

export function useDevSheetCycle(
  devSheet: string | undefined,
  {
    setConnectionOpen,
    setContextOpen,
    setPicker,
    setCommandsOpen,
    setAttachOpen,
    setNewChatOpen,
    setThought,
    setCarouselOpen,
    setMenuOpen,
  }: {
    setConnectionOpen: Setter<boolean>;
    setContextOpen: Setter<boolean>;
    setPicker: Setter<"model" | "mode" | null>;
    setCommandsOpen: Setter<boolean>;
    setAttachOpen: Setter<boolean>;
    setNewChatOpen: Setter<boolean>;
    setThought: Setter<string | null>;
    setCarouselOpen: Setter<boolean>;
    setMenuOpen: Setter<boolean>;
  },
) {
  // `EXPO_PUBLIC_DEV_SHEET=cycle` (development only): open each sheet in turn,
  // 7s apart, so one launch can be screenshotted sheet by sheet.
  useEffect(() => {
    if (devSheet !== "cycle") return;
    const steps: Array<() => void> = [
      () => setConnectionOpen(true),
      () => { setConnectionOpen(false); setContextOpen(true); },
      () => { setContextOpen(false); setPicker("model"); },
      () => { setPicker(null); setCommandsOpen(true); },
      () => { setCommandsOpen(false); setAttachOpen(true); },
      () => { setAttachOpen(false); setNewChatOpen(true); },
      () => { setNewChatOpen(false); setThought("The chunk is there on reopen, so the daemon has it. The phone drops it.\n\nReplay and live stream overlap at the cursor."); },
      () => { setThought(null); setCarouselOpen(true); },
      () => { setCarouselOpen(false); setMenuOpen(true); },
      () => setMenuOpen(false),
    ];
    let i = 0;
    const timer = setInterval(() => {
      steps[i]?.();
      i += 1;
      if (i >= steps.length) clearInterval(timer);
    }, 7000);
    return () => clearInterval(timer);
  }, [
    devSheet,
    setConnectionOpen,
    setContextOpen,
    setPicker,
    setCommandsOpen,
    setAttachOpen,
    setNewChatOpen,
    setThought,
    setCarouselOpen,
    setMenuOpen,
  ]);
}
