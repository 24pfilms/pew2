/**
 * The refs and setters `useDaemon` owns, as one explicit shape.
 *
 * The socket handler, the connection effect and the actions used to close over
 * these inside one 2,500-line hook. They now live in their own modules and are
 * handed this instead; every field is the hook's own `useRef`/`useState`
 * result, so identities are stable and nothing here is state of its own.
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SecureChannel, wire } from "@pew2/protocol";
import type { RestoreTarget } from "./restoreState";
import type { OutboxEntry } from "./outbox";
import type { Cursors } from "./cursors";
import type { PendingAttachment } from "./attachments";
import type { SlashCommand } from "./slashCommands";
import type { GgState } from "./ggState";
import type { ConfigOption, ImageEntry, Provider, Session } from "./daemonTypes";
import type { DaemonOptions, State, TurnFinished, VoiceFrame } from "./daemonState";
import type { CapabilityProbes } from "./capabilityProbes";
import type { ConnectionWatch } from "./connectionWatch";
import type { ListRefresh } from "./listRefresh";

export interface DaemonRefs {
  setState: Dispatch<SetStateAction<State>>;
  setGg: Dispatch<SetStateAction<GgState>>;
  setKnownConfigs: Dispatch<SetStateAction<Record<string, ConfigOption[]>>>;
  setKnownCommands: Dispatch<SetStateAction<Record<string, SlashCommand[]>>>;
  storeImage: (uri: string, entry: ImageEntry) => void;
  clearImages: () => void;
  requestedImages: RefObject<Set<string>>;
  goalCounter: RefObject<number>;
  restoring: RefObject<RestoreTarget | undefined>;
  streamGeneration: RefObject<number>;
  streamBoundary: RefObject<(() => void) | undefined>;
  streamForeground: RefObject<boolean>;
  socket: RefObject<WebSocket | null>;
  channel: RefObject<SecureChannel | null>;
  fatal: RefObject<boolean>;
  retry: RefObject<ReturnType<typeof setTimeout> | null>;
  attempts: RefObject<number>;
  alive: RefObject<boolean>;
  resume: RefObject<(() => void) | undefined>;
  sessionRef: RefObject<string | undefined>;
  viewingRef: RefObject<string | undefined>;
  providerRef: RefObject<string | undefined>;
  projectRef: RefObject<Record<string, string>>;
  queued: RefObject<{ text: string; attachments: readonly PendingAttachment[] } | undefined>;
  localSeq: RefObject<number>;
  outbox: RefObject<OutboxEntry[]>;
  pendingStart: RefObject<string | undefined>;
  awaitingResume: RefObject<boolean>;
  probed: RefObject<CapabilityProbes>;
  /** Whether the live socket is actually working, not merely open. See `connectionWatch.ts`. */
  watch: RefObject<ConnectionWatch | null>;
  /** A pull-to-refresh of the drawer, from the pull to the answer that ends it. */
  listRefresh: RefObject<ListRefresh>;
  setRefreshingList: Dispatch<SetStateAction<boolean>>;
  /** Turns already announced, so the effect that drains `completedTurns` does not repeat them. */
  notifiedTurns: RefObject<WeakSet<TurnFinished>>;
  onTurnFinished: RefObject<((turn: TurnFinished) => void) | undefined>;
  pendingCapabilities: RefObject<Set<string>>;
  pendingProjectSessions: RefObject<Set<string>>;
  browseRequest: RefObject<string | undefined>;
  browseCounter: RefObject<number>;
  cursors: RefObject<Cursors>;
  liveSessions: RefObject<Set<string> | undefined>;
  sessionsRef: RefObject<Session[]>;
  providersRef: RefObject<Provider[]>;
  optionsRef: RefObject<DaemonOptions>;
  turnText: RefObject<Map<string, string>>;
  pushRegistered: RefObject<boolean>;
  targetProviderRef: RefObject<string | undefined>;
  /** The voice call's ear on the socket: answers and status for a live call. */
  voiceListener: RefObject<((message: VoiceFrame) => void) | undefined>;
  /** Video requests waiting for the computer's answer, by request id: a card is waiting on each. */
  videoReplies: RefObject<Map<string, (reply: wire.VideoData) => void>>;
  /** Dashboard requests waiting for the computer's answer, by request id: the open dashboard waits on each. */
  dashReplies: RefObject<Map<string, (reply: wire.Dash) => void>>;
}
