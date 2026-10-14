/**
 * What the voice assistant needs from the daemon, as one narrow interface.
 *
 * The tools act through `dispatch`, which runs a frame through the very same
 * `handleMessage` a phone's frames go through. That is deliberate: a turn the
 * assistant starts must announce `session.started`, end with `session.idle`
 * and send its push exactly as one typed on the phone does, and the only way
 * to guarantee that is to not have a second code path.
 */
import { handleMessage } from "../handler.js";
import type { Daemon } from "../index.js";

export interface SessionView {
  sessionId: string;
  providerId: string;
  cwd: string;
  agentSessionId?: string;
  working: boolean;
  permissions: { requestId: string; params: unknown }[];
}

/** One thing that happened in a coding session, as the voice side sees it. */
export type VoiceObservation =
  | { sessionId: string; kind: "update"; payload: unknown }
  | { sessionId: string; kind: "turn_start" }
  | { sessionId: string; kind: "turn_end" };

export interface VoiceHost {
  readonly env: NodeJS.ProcessEnv;
  agents(): { id: string; name: string; available: boolean }[];
  projects(providerId: string): Promise<{ name: string; path: string }[]>;
  knownProject(providerId: string, cwd: string): Promise<string | undefined>;
  lastWorkspace(providerId: string): Promise<string | undefined>;
  session(sessionId: string): SessionView | undefined;
  /** The last user request and the agent's reply after it, from the session log. */
  lastExchange(sessionId: string): { request?: string; reply: string } | undefined;
  /** Run a client frame through the shared handler, collecting what it sent. */
  dispatch(
    frame: Record<string, unknown>,
    onReply?: (message: unknown) => void,
  ): Promise<{ broadcasts: unknown[]; replies: unknown[] }>;
  answerPermission(sessionId: string, requestId: string, optionId: string): boolean;
  /** To every client on every transport. */
  broadcast(message: unknown): void;
}

export function daemonHost(daemon: Daemon, env: NodeJS.ProcessEnv): VoiceHost {
  return {
    env,
    agents: () => daemon.voiceAgents(),
    projects: async (providerId) =>
      ((await daemon.capabilitiesFor(providerId)).projects ?? []).map((p) => ({
        name: p.name,
        path: p.path,
      })),
    knownProject: (providerId, cwd) => daemon.knownProject(providerId, cwd),
    lastWorkspace: (providerId) => daemon.lastWorkspace(providerId),
    session: (sessionId) => daemon.sessionView(sessionId),
    lastExchange: (sessionId) => daemon.lastExchange(sessionId),
    dispatch: async (frame, onReply) => {
      const broadcasts: unknown[] = [];
      const replies: unknown[] = [];
      await handleMessage(JSON.stringify(frame), {
        daemon,
        // A prompt's failure arrives after `handleMessage` has returned, so it
        // is handed on as well as collected.
        reply: (message) => {
          replies.push(message);
          onReply?.(message);
        },
        broadcast: (message) => {
          broadcasts.push(message);
          daemon.broadcast(message);
        },
      });
      return { broadcasts, replies };
    },
    answerPermission: (sessionId, requestId, optionId) =>
      daemon.answerPermission(sessionId, requestId, optionId),
    broadcast: (message) => daemon.broadcast(message),
  };
}
