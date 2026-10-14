/**
 * Staying connected with the screen off, and ringing when an agent needs you.
 *
 * Android only (`android/`); every call is a safe no-op elsewhere, and on a
 * build without the native module, so the app keeps its on-screen behaviour.
 * Probed with `requireOptionalNativeModule`, the same way `ui/speech.ts` probes
 * its module.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

type Subscription = { remove(): void };

/** A ring answered: the conversation, and whether to talk to Orca about it. */
export interface Answered {
  sessionId: string;
  voice: boolean;
}

interface PewLinkNative {
  start(title: string, text: string): boolean;
  stop(): void;
  isRunning(): boolean;
  startCall(title: string, text: string): boolean;
  endCall(): void;
  ring(id: string, title: string, text: string, sessionId: string, offerVoice: boolean): boolean;
  cancelRing(id: string): void;
  cancelAllRings(): void;
  canRingFullScreen(): boolean;
  takeAnswered(): Answered | null;
  batteryUnrestricted(): boolean;
  requestBatteryUnrestricted(): boolean;
  openAppSettings(): boolean;
  openFullScreenSettings(): boolean;
  openAutoStart(): boolean;
  addListener(event: "tick" | "stopped", listener: () => void): Subscription;
}

const native: PewLinkNative | null =
  Platform.OS === "android" ? requireOptionalNativeModule<PewLinkNative>("PewLink") : null;

/** True on a build that has the module: the background link and ringing exist. */
export const available = native !== null;

function guarded<T>(fallback: T, call: (module: PewLinkNative) => T): T {
  if (!native) return fallback;
  try {
    return call(native);
  } catch (error) {
    console.warn("[pew2] link module call failed", error);
    return fallback;
  }
}

/** Start the background service. Only works while the app is on screen. */
export const startLink = (title: string, text: string) => guarded(false, (m) => m.start(title, text));
export const stopLink = () => guarded(undefined, (m) => m.stop());
export const linkRunning = () => guarded(false, (m) => m.isRunning());

/**
 * Keep the microphone alive with the screen locked, for a voice call. Only
 * while the app is on screen with the microphone granted.
 */
export const startCall = (title: string, text: string) => guarded(false, (m) => m.startCall(title, text));
export const endCall = () => guarded(undefined, (m) => m.endCall());

/** @param offerVoice Answering talks to Orca about the conversation. */
export const ring = (id: string, title: string, text: string, sessionId: string, offerVoice = false) =>
  guarded(false, (m) => m.ring(id, title, text, sessionId, offerVoice));
export const cancelRing = (id: string) => guarded(undefined, (m) => m.cancelRing(id));
export const cancelAllRings = () => guarded(undefined, (m) => m.cancelAllRings());
export const canRingFullScreen = () => guarded(true, (m) => m.canRingFullScreen());
/** The ring that was answered, once, or null. */
export const takeAnswered = () => guarded<Answered | null>(null, (m) => m.takeAnswered());

export const batteryUnrestricted = () => guarded(true, (m) => m.batteryUnrestricted());
export const requestBatteryUnrestricted = () => guarded(false, (m) => m.requestBatteryUnrestricted());
export const openAppSettings = () => guarded(false, (m) => m.openAppSettings());
export const openFullScreenSettings = () => guarded(false, (m) => m.openFullScreenSettings());
export const openAutoStart = () => guarded(false, (m) => m.openAutoStart());

/** Every ~30 s while the service runs, including with JavaScript timers paused. */
export function onTick(listener: () => void): Subscription {
  return guarded<Subscription>({ remove() {} }, (m) => m.addListener("tick", listener));
}

/** The user tapped "Disconnect" on the ongoing notification. */
export function onStopped(listener: () => void): Subscription {
  return guarded<Subscription>({ remove() {} }, (m) => m.addListener("stopped", listener));
}
