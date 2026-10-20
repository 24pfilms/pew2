/**
 * Wire protocol between daemon <-> relay <-> app.
 *
 * ACP itself only standardises stdio framing; Streamable HTTP is still a draft
 * proposal (https://agentclientprotocol.com/protocol/transports). The spec
 * explicitly permits custom transports so long as the JSON-RPC message format
 * and lifecycle are preserved — that is exactly what this envelope does.
 *
 * Design rules:
 *  - Every session event carries a monotonic `seq`, so a reconnecting client
 *    says "I have up to N" and the relay replays N+1.. from its log.
 *    This is what makes phone and desktop show the same conversation.
 *  - The relay treats `payload` as opaque. Under E2EE it is a ciphertext blob.
 */
import { z } from "zod";
import { DashSnapshot, DashTask, DashTaskOp, DashViewItem, DashViewName } from "./dash.js";

export * from "./dash.js";

/**
 * Bump only on breaking envelope changes.
 *
 * 2 introduced end-to-end encryption: every message except `hello`, `ready` and
 * a relay-generated `error` now travels inside an `Envelope`. A v1 peer cannot
 * read v2 traffic at all, so the mismatch has to be *reported* — left unchecked
 * it surfaces as a socket that connects and then shows nothing, which looks
 * exactly like a broken daemon.
 */
export const WIRE_VERSION = 2;

/**
 * The per-session cursors off a cleartext `hello`, ignoring anything malformed.
 *
 * A `hello` is read before the channel exists, so it is never schema-validated
 * as a whole: whatever the socket sent is a plain `unknown`. Both transports
 * answer these cursors with a catch-up replay, and both must reject junk the
 * same way — a negative or fractional seq here would make `since()` slice from
 * the wrong end and re-send a whole session.
 */
export function readCursors(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const cursors: Record<string, number> = {};
  for (const [sessionId, seq] of Object.entries(value as Record<string, unknown>)) {
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) continue;
    cursors[sessionId] = seq;
  }
  return cursors;
}

/**
 * Whether a peer speaking `wire` can be talked to, and what to tell the user.
 *
 * Returns a sentence rather than a boolean so both sides say the same thing, and
 * so the side that is *behind* is named: "update the app" and "update pew2 on
 * your computer" are different actions, and guessing wrong wastes an evening.
 */
export function wireMismatch(peer: unknown): string | undefined {
  if (peer === WIRE_VERSION) return undefined;
  if (typeof peer !== "number" || !Number.isInteger(peer)) {
    return "This client did not say which protocol version it speaks. Update it and pair again.";
  }
  return peer < WIRE_VERSION
    ? `This app speaks protocol v${peer}, but this machine needs v${WIRE_VERSION}. Update the app and pair again.`
    : `This app speaks protocol v${peer}, but this machine only has v${WIRE_VERSION}. Update pew2 on your computer.`;
}

export const Role = z.enum(["daemon", "app"]);
export type Role = z.output<typeof Role>;

/**
 * Sent by both sides immediately after the socket opens.
 *
 * `wire` is *not* pinned to a literal here, and that is deliberate. Pinning it
 * would make a v1 `hello` fail schema validation and be discarded as malformed —
 * so the one client that most needs to be told "update the app" is the one that
 * could never receive the message. It is accepted as any integer and checked by
 * `wireMismatch`, which can then say something useful.
 */
export const Hello = z.object({
  t: z.literal("hello"),
  wire: z.number().int(),
  role: Role,
  deviceId: z.string().min(1),
  /** Highest seq the client already has, per session. Enables gap-free resume. */
  cursors: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /**
   * An envelope proving the sender holds the pairing key.
   *
   * `hello` cannot itself be encrypted — it is what establishes the connection —
   * so possession is proved beside it. Without this, knowing the relay room id
   * would be enough to open a socket the daemon then does work for, and the room
   * id is precisely what the relay is given.
   *
   * Optional in the schema so a v1 `hello` still parses far enough to be told
   * *why* it was refused, rather than being dropped as malformed.
   */
  proof: z.unknown().optional(),
});

/**
 * Relay -> both sides, after `hello`.
 *
 * One of the few frames that stay in cleartext: it carries no user content, and
 * it must be readable by a peer that cannot decrypt anything yet — including one
 * about to be told its protocol version is wrong.
 */
export const Ready = z.object({
  t: z.literal("ready"),
  wire: z.literal(WIRE_VERSION),
  /** Server time, used by clients to detect clock skew in rendered timestamps. */
  now: z.number().int(),
});

/**
 * Daemon -> relay -> app. The list of providers this machine can launch,
 * derived from the manifests in `providers/`. This is how a newly added
 * provider "just shows up" on the phone: the daemon rescans and re-announces.
 */
export const ProviderAnnounce = z.object({
  t: z.literal("providers"),
  machine: z.object({ id: z.string(), name: z.string() }),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      transport: z.string(),
      color: z.string().optional(),
      requiresWorkspace: z.boolean(),
      /** False when a required env var is missing; app shows why. */
      available: z.boolean(),
      unavailableReason: z.string().optional(),
    }),
  ),
  /**
   * Daemon session ids that are open *right now*.
   *
   * Session ids are assigned per daemon process and die with it, but a client
   * keeps its list across restarts and reconnects — so without this it will
   * happily prompt an id the daemon has never heard of ("Unknown session").
   * Sent on every announcement, and `hello` triggers one, so a reconnecting
   * app learns which of its conversations still exist and resumes the rest by
   * `agentSessionId`.
   */
  activeSessions: z.array(z.string()).default([]),
  /**
   * A newer pew2 has been published and this machine is not running it yet.
   *
   * Absent is the normal state, and deliberately means two different things:
   * either there is nothing newer, or this daemon predates the field. Both are
   * "say nothing", which is why it is optional rather than a nullable object —
   * an older daemon must never make the app claim it is up to date.
   *
   * Only sent while that version is *not installed*. A daemon that can update
   * itself does so within hours and this disappears on its own; one that cannot
   * — no service registered, an unwritable install directory, a download that
   * keeps failing — keeps saying so, because then a human has to re-run the
   * install line. That is the whole reason this reaches the phone: the daemon
   * has no screen of its own, and the person who can act is looking at this one.
   */
  update: z
    .object({
      /** The published version, e.g. "0.9.22". */
      latest: z.string(),
      /**
       * Whether the daemon expects to install it without being asked.
       *
       * False is the actionable case, and it is what turns the notice from a
       * status line into an instruction.
       */
      automatic: z.boolean(),
    })
    .optional(),
  /**
   * Whether this machine can host a live voice conversation (GPT-Live).
   *
   * Absent means a daemon older than voice, and the app shows no voice button
   * at all. Present but `available: false` means this daemon could, but has no
   * OpenAI API key yet (or this month's voice budget is spent): the button
   * stays, and tapping it says `reason`, because that is something the user can
   * fix at their desk.
   */
  voice: z
    .object({
      available: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
  /**
   * Whether this machine serves the OrcaZeroViva dashboard.
   *
   * Opt-in: sent only when the daemon runs with `PEW2_ORCA_DASHBOARD=1`, so
   * anyone else never sees a Dashboard row. Absent means off or an older
   * daemon; `available: false` shows the row dimmed with `reason`.
   */
  dashboard: z
    .object({
      available: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
});

/**
 * A selector the agent advertises: model, thinking level, permission mode.
 *
 * pew2 never stores model names of its own. The list is whatever the connected
 * app reports for its installed version, so upgrading that app changes the
 * options here with no release of pew2.
 */
export const ConfigOption = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** 'model' | 'thought_level' | 'mode' | 'model_config', or a custom '_' name. */
  category: z.string().optional(),
  type: z.string(),
  currentValue: z.union([z.string(), z.boolean()]),
  options: z
    .array(
      z.object({
        value: z.string(),
        name: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * A conversation the agent already holds on disk, from `session/list`.
 *
 * These are not pew2's sessions. Coding agents keep their own history, so work
 * begun at the desk must be reachable from the phone.
 */
export const AgentSession = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  /** ISO 8601 timestamp of last activity, when the agent tracks one. */
  updatedAt: z.string().optional(),
  /** Message rows available before the transcript is opened on the app. */
  messageCount: z.number().int().nonnegative().optional(),
});

/**
 * A project the agent has worked in, derived from its stored sessions.
 *
 * The drawer's history is capped at the newest conversations, so it is not a
 * list of projects: a busy week in one repo hides every other. This is folded
 * from the agent's *whole* `session/list` instead, which is why it carries its
 * own counts and its own last-activity stamp.
 */
export const AgentProject = z.object({
  /** Absolute path, and the identity of the project everywhere. */
  path: z.string(),
  /** Last path segment: the project as people say it. */
  name: z.string(),
  /** How many stored conversations live in it. */
  sessions: z.number().int().nonnegative(),
  /** ISO 8601 of the newest of those, when the agent dates them. */
  updatedAt: z.string().optional(),
});

/** One slash command an agent offers, e.g. from `.claude/commands`. */
export const SlashCommand = z.object({
  name: z.string(),
  description: z.string(),
  /** Placeholder for the argument it expects, when it takes one. */
  hint: z.string().optional(),
});

/** App -> daemon. What does this provider currently offer? */
export const ProviderCapabilitiesRequest = z.object({
  t: z.literal("provider.capabilities"),
  providerId: z.string(),
  /** Re-probe instead of answering from cache, e.g. after the agent updates. */
  refresh: z.boolean().optional(),
});

/**
 * Daemon -> app. What the provider offers, learned by asking the agent: its
 * live selectors and its own stored conversations. Sent before any session
 * exists so the empty state shows real options and real history.
 */
export const ProviderCapabilities = z.object({
  t: z.literal("provider.capabilities"),
  providerId: z.string(),
  configOptions: z.array(ConfigOption),
  sessions: z.array(AgentSession),
  /** Whether those sessions can be reopened, i.e. the agent supports load. */
  canResume: z.boolean(),
  /**
   * Slash commands the agent offers, learned from the probe session.
   *
   * Optional so a daemon older than this field still validates. They depend on
   * the project the agent opened, which is why they travel with capabilities
   * rather than being a fixed property of the provider.
   */
  commands: z.array(SlashCommand).optional(),
  /**
   * Every project this agent holds history for, newest first.
   *
   * Optional so an older daemon still validates; the app then falls back to
   * the projects it can see in `sessions`.
   */
  projects: z.array(AgentProject).optional(),
  /** GG Coder extensions this agent speaks; see `ProviderExtensions`. */
  extensions: z.lazy(() => ProviderExtensions).optional(),
});

/**
 * App -> daemon. The agent's conversations in one project.
 *
 * `sessions` above is the newest handful across everything, which is the wrong
 * list once a project is chosen — a repo touched last month has none of its
 * conversations in it. The daemon answers from the full list it already read.
 */
export const ProviderSessionsRequest = z.object({
  t: z.literal("provider.sessions"),
  providerId: z.string(),
  /** Absolute project path, as given in `AgentProject.path`. */
  cwd: z.string(),
});

/** Daemon -> app. Answer to `provider.sessions`. */
export const ProviderSessions = z.object({
  t: z.literal("provider.sessions"),
  providerId: z.string(),
  cwd: z.string(),
  sessions: z.array(AgentSession),
  /** Same gate as capabilities: rows that cannot be reopened are not listed. */
  canResume: z.boolean(),
});

/**
 * App -> daemon. Choose a selector before any session exists.
 *
 * A conversation is only created by its first prompt, so a model or mode picked
 * in the empty state has nothing to be applied to yet. The daemon remembers it
 * against the provider, and the session that prompt creates opens with it set.
 */
export const SetProviderConfig = z.object({
  t: z.literal("provider.config"),
  providerId: z.string(),
  configId: z.string(),
  value: z.union([z.string(), z.boolean()]),
});

/**
 * Daemon -> app. What a *new* session on this provider will open with.
 *
 * The same `t` in the other direction, exactly as `session.config` already
 * works: the app names a choice, the daemon answers with the resulting set.
 *
 * Broadcast rather than replied to, and sent for a change made anywhere —
 * including one made inside a live conversation, which the daemon also records
 * against the provider. Without it the empty state kept showing whichever
 * selectors the last conversation happened to hold, while the next prompt
 * opened at the remembered ones: a pill naming a model that was not the model
 * about to run. Two devices make that worse, since a choice at the desk moves
 * what the phone's next prompt will use.
 */
export const ProviderConfig = z.object({
  t: z.literal("provider.config"),
  providerId: z.string(),
  configOptions: z.array(ConfigOption),
});

/** App -> daemon. Reopen one of the agent's own past conversations. */
export const ResumeSession = z.object({
  t: z.literal("session.resume"),
  providerId: z.string(),
  /** The agent's session id, as reported by `session/list`. */
  agentSessionId: z.string(),
  cwd: z.string().optional(),
});

/**
 * App -> daemon. Find somewhere to work.
 *
 * The project list in the drawer is folded from an agent's own past sessions,
 * so a freshly installed agent offers nothing and cannot be started. The
 * directories are on the desktop, and a phone's file picker returns a handle
 * that machine cannot use — so the daemon looks and the phone renders.
 *
 * Omit `path` for the opening view: a scan for git checkouts, which is what
 * makes this usable on a touchscreen instead of a walk down from `/`.
 */
export const WorkspacesRequest = z.object({
  t: z.literal("workspaces"),
  requestId: z.string(),
  /** Browse this directory. Absent means "suggest repositories". */
  path: z.string().optional(),
  /** Also list the browsed directory's regular files (goal context). Absent = folders only. */
  files: z.boolean().optional(),
});

export const WorkspaceEntry = z.object({
  path: z.string(),
  name: z.string(),
  repo: z.boolean(),
  updatedAt: z.string().optional(),
  /** Absent means folder: older daemons never list files. Files are never browsable. */
  kind: z.enum(["folder", "file"]).optional(),
});

/** Daemon -> app. Answer to `workspaces`. */
export const Workspaces = z.object({
  t: z.literal("workspaces"),
  requestId: z.string(),
  /** The directory listed, absent for the suggestions view. */
  path: z.string().optional(),
  /** Where "up" goes, absent at a browsable root. */
  parent: z.string().optional(),
  entries: z.array(WorkspaceEntry),
  /**
   * The request named a path that is missing, not a directory, or outside the
   * roots browsing is allowed to reach. One flag rather than three: the client
   * shows the same "can't open that" either way, and distinguishing them tells
   * a caller holding a stolen token what exists on the disk.
   */
  refused: z.boolean().default(false),
});

/** App -> daemon. Start a new session with a provider. */
export const StartSession = z.object({
  t: z.literal("session.start"),
  /**
   * Echoed back on `session.started`, so a client can tell the session it asked
   * for from one another device started.
   *
   * `session.started` is broadcast to every paired client, and without this
   * none of them could tell which request a given one answered. Each assumed it
   * was its own: starting a conversation anywhere redirected every other device
   * to it, and — because the frame carries no transcript — redirected them to a
   * blank one.
   *
   * Optional because a client need not send one, and because requiring it would
   * reject every `session.start` from a client older than this field the moment
   * the daemon began validating against this schema.
   */
  requestId: z.string().optional(),
  providerId: z.string(),
  cwd: z.string().optional(),
});

/**
 * A file the phone is sending *to* the agent, inlined.
 *
 * The reverse direction of `ImageData`: that machine cannot see the phone's
 * camera roll any more than the phone can see its disk, so the bytes travel in
 * the prompt and the daemon writes them somewhere the agent can open.
 */
export const PromptAttachment = z.object({
  /** Display name only. The daemon sanitises it before it becomes a path. */
  name: z.string().min(1),
  mimeType: z.string(),
  /** Base64, no `data:` prefix. */
  data: z.string(),
});

/**
 * Ceilings for one prompt's attachments.
 *
 * Base64 inflates by a third, so 12MB of files is ~16MB on the wire — inside
 * the relay Durable Object's 32 MiB received-message limit, which is otherwise
 * hit as a socket that simply dies. Checked on the phone, where the reason can
 * be shown, *and* in the daemon, which cannot trust a client.
 */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 12 * 1024 * 1024;

/** App -> daemon. Send a prompt into an existing session. */
export const Prompt = z.object({
  t: z.literal("session.prompt"),
  sessionId: z.string(),
  text: z.string(),
  /** Defaulted, so a client older than attachments still validates. */
  attachments: z.array(PromptAttachment).default([]),
  /**
   * Set when the words are Orca's, the voice assistant speaking for the user,
   * rather than typed. Passed to the agent, which can then say so when it
   * shows the chat.
   */
  origin: z.literal("voice").optional(),
});

/** App -> daemon. Interrupt the current turn. */
export const Cancel = z.object({
  t: z.literal("session.cancel"),
  sessionId: z.string(),
});

/**
 * App -> daemon. Change a selector on a live session.
 *
 * The counterpart to {@link SetProviderConfig}, which is the same choice made
 * before any session exists. Both halves of that pair have to be described, or
 * validating inbound messages refuses every model switch made mid-conversation.
 */
export const SetSessionConfig = z.object({
  t: z.literal("session.config"),
  sessionId: z.string(),
  configId: z.string(),
  value: z.union([z.string(), z.boolean()]),
});

/** App -> daemon. Answer an outstanding permission request. */
export const PermissionReply = z.object({
  t: z.literal("session.permission"),
  sessionId: z.string(),
  requestId: z.string(),
  optionId: z.string(),
});

/**
 * App -> daemon. Fetch an image the agent referenced by path.
 *
 * Agents that generate or inspect images name a file on the *desktop*: a
 * `resource_link`, or plain markdown like `![](.gg/generated/x.png)`. The phone
 * cannot read that disk, so the picture is a blank box unless the daemon hands
 * the bytes over the same socket everything else uses.
 */
export const ImageRequest = z.object({
  t: z.literal("image.fetch"),
  /** Echoed back, so a client can match a reply to the view that asked. */
  requestId: z.string(),
  /** Which session's working directory relative paths resolve against. */
  sessionId: z.string().optional(),
  uri: z.string(),
  /**
   * Send the bytes as `media.part` pieces instead of one message. Set by apps
   * that can put them back together; an older app leaves it out and gets the
   * single message it always got.
   */
  chunked: z.boolean().optional(),
});

/**
 * Daemon -> app. The image, inlined.
 *
 * Answered as a reply rather than a session event: this is bytes on demand for
 * one client's viewport, and putting megabytes of base64 into the replayable
 * log would make every reconnect re-download every picture ever shown.
 */
export const ImageData = z.object({
  t: z.literal("image"),
  requestId: z.string(),
  uri: z.string(),
  /** `data:<mime>;base64,...`, absent when `error` explains why not. */
  dataUri: z.string().optional(),
  mimeType: z.string().optional(),
  error: z.string().optional(),
  /** Sent as this many `media.part` pieces, which now make up the whole; `dataUri` is absent. */
  parts: z.number().int().positive().optional(),
});

/**
 * App -> daemon. Fetch a finished video the agent named by path.
 *
 * The same shape as `ImageRequest`, and answered the same way, but asked only
 * when the user taps a video card: a clip is megabytes, so nothing fetches
 * one on its own.
 */
export const VideoRequest = z.object({
  t: z.literal("video.fetch"),
  /** Echoed back, so a client can match a reply to the card that asked. */
  requestId: z.string(),
  /** Which session's working directory relative paths resolve against. */
  sessionId: z.string().optional(),
  uri: z.string(),
  /**
   * Send the bytes as `media.part` pieces instead of one message. Set by apps
   * that can put them back together; an older app leaves it out and gets the
   * single message it always got.
   */
  chunked: z.boolean().optional(),
});

/**
 * A video, answered to one client and never entered into the replayable log
 * (megabytes of base64 there would be re-downloaded on every reconnect).
 */
export const VideoData = z.object({
  t: z.literal("video"),
  requestId: z.string(),
  uri: z.string(),
  /** `data:<mime>;base64,...`, absent when `error` explains why not. */
  dataUri: z.string().optional(),
  mimeType: z.string().optional(),
  error: z.string().optional(),
  /** Sent as this many `media.part` pieces, which now make up the whole; `dataUri` is absent. */
  parts: z.number().int().positive().optional(),
});

/**
 * Daemon -> app. One piece of a picture or video asked for with `chunked`.
 *
 * A whole picture or clip in one message was megabytes of base64 in a single
 * relay frame, and twice on 2026-10-20 the relay link dropped right after one
 * (about 20 pictures at once; an 8.2 MB video), taking the phone offline for a
 * minute and a half. Pieces are small, and the daemon sends only a few ahead of
 * what the phone has confirmed (`media.ack`), so the link is never flooded.
 * The `image` / `video` reply that follows says how many there were.
 */
export const MediaPart = z.object({
  t: z.literal("media.part"),
  requestId: z.string(),
  /** 0-based position of this piece. */
  index: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  /** A slice of the base64 text; the pieces joined in order are the whole of it. */
  data: z.string(),
});

/** App -> daemon. How many pieces of a `chunked` transfer have arrived, in order. */
export const MediaAck = z.object({
  t: z.literal("media.ack"),
  requestId: z.string(),
  received: z.number().int().nonnegative(),
});

/**
 * App -> daemon. Which project is this session in, and how dirty is it?
 *
 * The phone has no filesystem to look at, so the working directory and the
 * count of uncommitted files are the only context it can offer before a prompt
 * goes out. Asked on demand rather than streamed: it changes with the agent's
 * own edits, so the app re-asks whenever a turn ends.
 */
export const WorkspaceRequest = z.object({
  t: z.literal("workspace.status"),
  /** The open session, whose cwd is the project being described. */
  sessionId: z.string().optional(),
  /**
   * Fallback before a session exists: the agent's own last project, which is
   * where the daemon would open one. No arbitrary path is accepted from the
   * client — the daemon resolves the directory itself.
   */
  providerId: z.string().optional(),
  /**
   * A project the user picked, so the composer can name where the next prompt
   * will land before any session exists.
   *
   * Honoured only when it is one of the projects this daemon itself announced
   * for that provider; anything else falls back as if it were absent, so this
   * cannot be used to ask whether some other directory exists.
   */
  cwd: z.string().optional(),
});

/** Daemon -> app. The answer to `workspace.status`. */
export const Workspace = z.object({
  t: z.literal("workspace"),
  sessionId: z.string().optional(),
  cwd: z.string(),
  /** Last path segment: the project's name as people say it. */
  folder: z.string(),
  /** False when the directory is not inside a git working tree. */
  repo: z.boolean(),
  /** Changed, staged and untracked entries, as `git status` counts them. */
  uncommitted: z.number().int().nonnegative(),
});

/**
 * Daemon -> relay -> app. An ordered, append-only event for a session.
 * `payload` mirrors the ACP `session/update` notification so the app renders
 * agent output without pew2 inventing a second content model.
 */
export const SessionEvent = z.object({
  t: z.literal("session.event"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.number().int(),
  payload: z.unknown(),
});

/** Relay -> app. Replayed history after a resume, oldest first. */
export const Replay = z.object({
  t: z.literal("session.replay"),
  sessionId: z.string(),
  events: z.array(SessionEvent),
  /** False for a progressive resume batch; omitted/true marks replay complete. */
  complete: z.boolean().optional(),
  /**
   * This batch is a reconnect catch-up, not history.
   *
   * The two arrive in the same frame but mean opposite things. A resume replay
   * is a transcript of work that finished long ago, so it must not light up the
   * activity line. A catch-up is the last few seconds of a turn that is *still
   * running* — the tool calls in it are what the agent is doing right now, and
   * dropping them is why a phone that lost its socket mid-turn showed nothing
   * until the agent happened to start another tool.
   */
  catchUp: z.boolean().optional(),
  /**
   * Whether a turn is still in flight, on a catch-up frame.
   *
   * `session.idle` is broadcast, not logged, so a turn that ended while the
   * client was away leaves no event to replay. Without this the app would stay
   * busy forever after catching up on a finished turn.
   */
  working: z.boolean().optional(),
  /**
   * Approval requests this session is still blocked on, on a catch-up frame.
   *
   * The one piece of a turn that a replayed event stream cannot carry. A
   * permission request *is* in the log, but the app deliberately ignores it
   * there: in a resumed transcript it was answered long ago, and raising it
   * again is a phantom approve sheet over finished history. So a phone that
   * dropped its signal at the wrong moment came back to a spinner, with the
   * agent on the desktop waiting on an answer nobody could give — no timeout on
   * either side, so the turn simply stopped.
   *
   * This is the daemon saying which requests are open *right now*, which only
   * it can know: the resolver lives with the ACP connection. Same shape as the
   * logged event's payload, so both paths render through one reader.
   */
  permissions: z
    .array(z.object({ requestId: z.string(), params: z.unknown() }))
    .optional(),
  /**
   * Same rule for queued messages, open `ask_user` questions and goal state:
   * live state only the daemon holds. Absent = an older daemon said nothing;
   * `[]` = none. Defined after their schemas below (lazy, so order is free).
   */
  queued: z.lazy(() => z.array(QueuedMessage)).optional(),
  asks: z.lazy(() => z.array(AskRequest)).optional(),
  goal: z.lazy(() => GoalState).optional(),
  plan: z.lazy(() => PlanState).optional(),
  autopilot: z.lazy(() => AutopilotState).optional(),
});

/**
 * Daemon -> app. A turn finished; the agent is waiting on you again.
 *
 * Broadcast to every client, not just the one that prompted, because the phone
 * is very often not the device watching this session — and it is the only
 * signal a client has that a conversation it left running is done. The project
 * travels with it so a notification can name the work ("pew2") without the app
 * holding a path for every session it has ever seen.
 */
export const SessionIdle = z.object({
  t: z.literal("session.idle"),
  sessionId: z.string(),
  /** The agent that ran the turn, so a client can name it. */
  providerId: z.string().optional(),
  /** Last segment of the session's cwd: the project as people say it. */
  folder: z.string().optional(),
  /**
   * Set when this turn kept a promise to call the user back. The call itself
   * travels as `callback.due`, which is resent until the phone confirms it;
   * this only stops the same turn ringing twice.
   */
  callbackId: z.string().optional(),
});

/**
 * Daemon -> app. Call the user: a job they asked to be called about has ended,
 * stopped, or gone quiet.
 *
 * Unlike `session.idle`, which is said once and lost if the phone is not
 * listening at that moment, this is held by the daemon and resent — on every
 * `hello` and on a timer — until the phone answers with `callback.ack`. That is
 * the difference between "usually rings" and "rings": the relay drops for a
 * minute or two at a time, and a job finishing inside that window used to end
 * in silence.
 */
export const CallbackDue = z.object({
  t: z.literal("callback.due"),
  /** Stable across resends, so the phone rings once however often it hears it. */
  id: z.string(),
  sessionId: z.string(),
  /** Finished; ended with an error; or quiet long enough to look stuck. */
  outcome: z.enum(["done", "failed", "stalled"]),
  title: z.string(),
  body: z.string(),
  providerId: z.string().optional(),
  folder: z.string().optional(),
});

/** App -> daemon. The phone has rung (or shown) a `callback.due`; stop resending it. */
export const CallbackAck = z.object({
  t: z.literal("callback.ack"),
  id: z.string(),
});

/**
 * App -> daemon. Where to push when this phone is not listening.
 *
 * The local banner can only fire while the app's JavaScript is running, and iOS
 * suspends that within seconds of the app leaving the screen — so the one case
 * notifications exist for, a long turn landing while the phone is in a pocket,
 * is the exact case it could not cover. The turn was announced minutes late, on
 * reopening, when the socket came back and `session.idle` finally arrived.
 *
 * A remote push has to come from something still awake, which is the daemon.
 * This is how it learns where to send one.
 *
 * Travels sealed like every other post-handshake frame, so the relay never sees
 * the token. The relay is otherwise not involved: the desktop has internet and
 * calls the push service itself, which keeps the relay a dumb pipe that stores
 * nothing.
 *
 * Sent on every connect, because push tokens rotate.
 *
 * Deliberately not a `WIRE_VERSION` bump. A new message type is additive: a
 * daemon that predates it answers `unknown_message`, which the app treats as a
 * refusal and falls back to its local-only banners — exactly the behaviour it
 * had before. Bumping would instead refuse the connection outright and take
 * working sessions down to deliver a notification improvement.
 *
 * The daemon says nothing on success. Silence is acceptance; only a refusal is
 * spoken, so the app must not assume a token it holds is a token the daemon
 * kept.
 */
export const PushRegister = z.object({
  t: z.literal("app.push"),
  /**
   * An Expo push token (`ExponentPushToken[...]`).
   *
   * Not a bare APNs/FCM token: sending to those needs signing credentials, which
   * live in EAS and must not ship inside a daemon anyone can read the source of.
   */
  token: z.string().min(1),
  platform: z.enum(["ios", "android"]),
});

/**
 * Daemon -> every other client, when one of them says `hello`.
 *
 * The daemon is the only party that sees arrivals on both transports, so it is
 * the only party that can report them consistently. `pew2 pair` uses this to
 * turn a printed QR into a confirmed pairing; clients that do not care are
 * expected to ignore it.
 */
export const DeviceJoined = z.object({
  t: z.literal("device.joined"),
  deviceId: z.string(),
  at: z.number().int(),
});

// ── Queued messages ────────────────────────────────────────

/**
 * A message the user sent while a turn was running, waiting for the agent to
 * pick it up. Same affordance as GG Coder's desktop queue strip.
 *
 * The daemon owns the queue for *every* agent: an agent that advertises GG's
 * queue extension (`agentCapabilities._meta.gg.queue`) receives it mid-run and
 * folds it in at its next step; any other agent gets everything still queued
 * as its next turn the moment the current one ends. Ids are daemon-minted.
 */
export const QueuedMessage = z.object({
  id: z.string(),
  text: z.string(),
  /** How many files ride with it, for the strip's paperclip; absent means none. */
  attachments: z.number().int().nonnegative().optional(),
});

/**
 * Daemon -> app. A session's queue changed: broadcast, never logged.
 *
 * The full list every time (replace, never patch). A queued message that is
 * picked up leaves this list *and* appears in the log as an ordinary
 * `user_message` at the moment it reached the agent, so the transcript shows
 * it where the agent actually read it.
 */
export const SessionQueue = z.object({
  t: z.literal("session.queue"),
  sessionId: z.string(),
  queued: z.array(QueuedMessage),
  /**
   * Messages taken off the queue *unsent* because the turn was cancelled. GG
   * Coder hands these back to the composer rather than running them after a
   * stop; a client puts them back into an empty draft, and ignores them
   * otherwise. Absent on every other update.
   */
  returned: z.array(QueuedMessage).optional(),
});

/** App -> daemon. Withdraw one queued message before the agent reads it. */
export const QueueCancel = z.object({
  t: z.literal("session.queue.cancel"),
  sessionId: z.string(),
  id: z.string(),
});

// ── ask_user ───────────────────────────────────────────────

/** One selectable answer. `value` is what the agent gets back; `label` is UI. */
export const AskOption = z.object({
  label: z.string(),
  value: z.string().optional(),
  /** One short line under the label. */
  hint: z.string().optional(),
  /** The agent's recommendation: tagged in the UI, never preselected. */
  recommended: z.boolean().optional(),
});

export const AskQuestion = z.object({
  /** The key this question's answer comes back under. */
  id: z.string(),
  question: z.string(),
  kind: z.enum(["confirm", "choice", "multi", "text"]),
  detail: z.string().optional(),
  /** `confirm` without options means Yes / No. */
  options: z.array(AskOption).optional(),
  /** Whether a free-text answer is offered beside the options (default true; always on `text`). */
  allowOther: z.boolean().optional(),
});

/**
 * An open question from the agent (GG Coder's `ask_user` tool), relayed from
 * the ACP extension request `_gg/ask_user`.
 *
 * Logged as a session event with payload `{ kind: "ask_user", requestId,
 * questions }`, and — exactly like a permission — carried as live state in a
 * catch-up `Replay.asks`, because a logged question is history and must never
 * re-open a card over a finished transcript.
 *
 * When it stops being open — answered from any client, withdrawn or
 * superseded by the agent, or its session/connection closed — the daemon logs
 * `{ kind: "ask_user_closed", requestId }`, which closes the card everywhere.
 * An ask may outlive the turn that raised it.
 */
export const AskRequest = z.object({
  requestId: z.string(),
  questions: z.array(AskQuestion),
});

/** What the agent hears back. Mirrors GG Coder's `AskUserResult` subset. */
export const AskResult = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("answer"),
    /** Question id -> chosen value (or label when it has none), typed text, or several for `multi`. */
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
  z.object({ action: z.literal("cancel") }),
]);

/** App -> daemon. Answer (or dismiss) an open question. */
export const AskReply = z.object({
  t: z.literal("session.ask"),
  sessionId: z.string(),
  requestId: z.string(),
  result: AskResult,
});

// ── Goals (GG Coder) ───────────────────────────────────────

/**
 * A GG Coder goal: a long-running objective worked by GG Goals, a
 * coordinator agent whose working directory is the goal's own folder
 * (`~/.gg/goals/<id>`). Goals live on the desktop's disk and are shared with
 * GG Coder's desktop app; the phone lists, creates and opens them through the
 * `ggcoder` provider's ACP extension methods (`_gg/goals/*`).
 */
export const GoalStatus = z.enum(["briefing", "running", "paused", "interrupted", "idle"]);

export const GoalContextItem = z.object({
  kind: z.enum(["folder", "file"]),
  path: z.string(),
});

export const GoalSummary = z.object({
  id: z.string(),
  name: z.string(),
  /** The goal text as the user wrote it. */
  goal: z.string(),
  context: z.array(GoalContextItem),
  /** The goal folder: open a goal by starting/resuming a ggcoder session with this as cwd. */
  path: z.string(),
  createdAt: z.string(),
  lastActiveMs: z.number(),
  /** The newest coordinator conversation, to resume; absent opens a fresh one. */
  agentSessionId: z.string().optional(),
  status: GoalStatus,
  /** Daemon session id currently open on this goal, when one is. */
  sessionId: z.string().optional(),
  /** Standing instructions for the goal's workers. Absent = none (or an older GG Coder). */
  instructions: z.string().optional(),
});

/** App -> daemon. List the goals on this machine. */
export const GoalsRequest = z.object({
  t: z.literal("goals"),
  requestId: z.string(),
});

/** Daemon -> app. Answer to `goals`; also broadcast unprompted after any change. */
export const Goals = z.object({
  t: z.literal("goals"),
  /** Echoed when this answers a request; absent on a broadcast. */
  requestId: z.string().optional(),
  goals: z.array(GoalSummary),
  /** Why there are none to show: GG Coder missing, too old, or failed. Absent on success. */
  error: z.string().optional(),
});

/**
 * App -> daemon. Fetch the OrcaZeroViva dashboard snapshot.
 *
 * The only choice the phone makes is a page name from a fixed list
 * (`view`); absent means the summary. The daemon builds the request to Orca
 * from constants, so nothing from the phone ever reaches the PC's pipe.
 */
export const DashRequest = z.object({
  t: z.literal("dash"),
  requestId: z.string(),
  view: DashViewName.optional(),
  /** Add or complete a task. Takes the place of `view`; an older daemon drops it and answers a snapshot. */
  task: DashTaskOp.optional(),
});

/** Daemon -> app. Answer to `dash`: a snapshot, or a sentence saying why not. */
export const Dash = z.object({
  t: z.literal("dash"),
  requestId: z.string(),
  snapshot: DashSnapshot.optional(),
  /**
   * Answer to a `view` request. An older daemon ignores `view` and answers
   * with a snapshot instead, so the app treats a reply without `view` as
   * "this computer can't show pages yet".
   */
  view: DashViewName.optional(),
  items: z.array(DashViewItem).optional(),
  generatedAt: z.number().optional(),
  /** The task an add or complete produced, as Orca now holds it. */
  task: DashTask.optional(),
  /** Plain words for the person holding the phone. Absent on success. */
  error: z.string().optional(),
});

/** App -> daemon. Create a goal (briefing phase). Context paths are desktop paths. */
export const GoalCreate = z.object({
  t: z.literal("goal.create"),
  requestId: z.string(),
  name: z.string(),
  goal: z.string(),
  context: z.array(z.string()).default([]),
  instructions: z.string().optional(),
  /**
   * Files picked on the *phone* (the desktop's disk is no place to hunt for a
   * file from a phone). The daemon writes them to pew2's own folder on the
   * computer, where they live as long as the goal, and adds their paths to
   * `context`. Same ceilings as a prompt's attachments. Absent = none; an
   * older daemon drops the field, which is why `GoalResult.files` exists.
   */
  files: z.array(PromptAttachment).optional(),
});

/**
 * App -> daemon. Act on one goal.
 *  - `delete`: remove it (refused while a session on it is working).
 *  - `pause`: stop its run and its workers; it stays paused until resumed.
 *  - `resume`: lift a pause and carry on if it was cut off.
 *  - `update`: change attached context / standing instructions (refused mid-run).
 *  - `critterModel`: pin the workers' model (`model: null` follows GG Goals).
 * Opening a goal is not here: it is `session.start` / `session.resume` on the
 * `ggcoder` provider with `cwd` = the goal's `path`, after which the daemon
 * runs GG Goals' kickoff turn by itself when the goal still needs one.
 */
export const GoalAction = z.object({
  t: z.literal("goal.action"),
  requestId: z.string(),
  goalId: z.string(),
  action: z.enum(["delete", "pause", "resume", "update", "critterModel"]),
  context: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  model: z.string().nullable().optional(),
});

/** Daemon -> app. Result of `goal.create` / `goal.action`. */
export const GoalResult = z.object({
  t: z.literal("goal.result"),
  requestId: z.string(),
  ok: z.boolean(),
  goal: GoalSummary.optional(),
  error: z.string().optional(),
  /**
   * How many phone files were saved for a `goal.create`. Absent from a daemon
   * that predates `GoalCreate.files`: the app then knows its files were not
   * received rather than assuming they were.
   */
  files: z.number().int().nonnegative().optional(),
});

/** One of GG Goals' workers ("critters"), as the goal's farm shows it. */
export const GoalWorker = z.object({
  id: z.string(),
  /** The task name GG Goals gave it. */
  name: z.string(),
  /** builder | scout | researcher | checker, when known. */
  agent: z.string().optional(),
  state: z.enum(["starting", "running", "completed", "failed", "interrupted", "closed"]),
  /** What it is doing right now, one line. */
  activity: z.string().optional(),
  startedAt: z.number().optional(),
  elapsedMs: z.number().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Daemon -> app. Live state of the goal a session coordinates: phase and the
 * worker roster. Broadcast on change (full state each time), carried in a
 * catch-up `Replay.goal`, never logged. Ken's spoken line is NOT here: it is
 * the last line of GG Goals' message text (`[ken:face] words`), which the app
 * strips from the bubble and shows as Ken.
 */
export const GoalState = z.object({
  t: z.literal("goal.state"),
  sessionId: z.string(),
  goalId: z.string(),
  phase: z.enum(["briefing", "active"]),
  paused: z.boolean(),
  workers: z.array(GoalWorker),
  critterModel: z.string().nullable().optional(),
});

// ── Plan review (GG Coder) ─────────────────────────────────

/**
 * Daemon -> app. A session's plan state (from `_gg/plan_state`): broadcast on
 * change, carried in a catch-up `Replay.plan`, never logged.
 *
 * `pending` is present only while a submitted plan is waiting for the HUMAN
 * (GG Coder already let Autopilot Ken try, and everything has settled). That is
 * the moment the app opens the Accept / Feedback / Reject sheet. Progress of an
 * approved plan travels as the standard ACP `plan` session update, not here.
 */
export const PlanState = z.object({
  t: z.literal("plan.state"),
  sessionId: z.string(),
  /** The agent is in read-only plan mode, drafting. */
  planMode: z.boolean(),
  pending: z
    .object({
      planPath: z.string(),
      /** The plan's markdown. */
      content: z.string(),
      /** Echo this back in `plan.decide`, so a stale sheet cannot decide a newer plan. */
      generation: z.number().int(),
    })
    .nullable(),
});

/**
 * App -> daemon. Decide a pending plan.
 *  - `accept`: implement it. GG Coder starts a fresh context with the plan
 *    baked in (same daemon session; the transcript gets a divider).
 *  - `feedback`: revise it read-only with `feedback`, then submit again.
 *  - `reject`: drop it; the agent leaves plan mode and waits.
 * Logged as `{ kind: "plan_decision", action, feedback? }`.
 */
export const PlanDecide = z.object({
  t: z.literal("plan.decide"),
  sessionId: z.string(),
  generation: z.number().int(),
  action: z.enum(["accept", "feedback", "reject"]),
  feedback: z.string().optional(),
});

// ── Autopilot (GG Coder) ───────────────────────────────────

/**
 * Daemon -> app. Whether Autopilot (Ken reviewing every finished turn and
 * prompting GG Coder until the work is done) is on for this session's project,
 * and whether Ken is reviewing right now. Broadcast on change, catch-up
 * `Replay.autopilot`, never logged. Ken's verdicts themselves ARE logged, as
 * session events `{ kind: "autopilot", phase, reason?, body?, round? }` with
 * phase one of: review_start | prompted | done | human | capped | ignored |
 * plan_accepted | error.
 */
export const AutopilotState = z.object({
  t: z.literal("autopilot.state"),
  sessionId: z.string(),
  enabled: z.boolean(),
  reviewing: z.boolean(),
});

/** App -> daemon. Turn Autopilot on or off for this session's project. */
export const AutopilotSet = z.object({
  t: z.literal("autopilot.set"),
  sessionId: z.string(),
  enabled: z.boolean(),
});

// ── Project checklist (GG Coder) ───────────────────────────

export const ChecklistItemRow = z.object({
  id: z.string(),
  /** Section heading, e.g. "Foundations". */
  group: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["not-run", "not-applicable", "due", "passed", "needs-work"]),
  checkedAt: z.string().nullable(),
  result: z.enum(["pass", "issues", "not-applicable"]).nullable(),
  summary: z.string().nullable(),
  findings: z.array(z.string()),
  evidence: z.array(z.string()),
  /** The project's code changed after this result was recorded. */
  changedSinceCheck: z.boolean(),
  /** What GG Coder detected about this project for the item, when anything. */
  detection: z.object({ summary: z.string(), facts: z.array(z.string()) }).nullable(),
  /** Send this as an ordinary prompt to run the check; null when it can't be run. */
  runPrompt: z.string().nullable(),
});

/** App -> daemon. Read the project checklist for an open GG Coder session. */
export const ChecklistRequest = z.object({
  t: z.literal("checklist"),
  requestId: z.string(),
  sessionId: z.string(),
});

/**
 * Daemon -> app. Answer to `checklist` (with `requestId`), or a nudge with no
 * items when a turn changed the checklist (`changed: true`, the app re-asks).
 */
export const Checklist = z.object({
  t: z.literal("checklist"),
  requestId: z.string().optional(),
  sessionId: z.string(),
  changed: z.boolean().optional(),
  staleAfterDays: z.number().optional(),
  items: z.array(ChecklistItemRow).optional(),
  error: z.string().optional(),
});

/**
 * Which GG Coder extensions this provider speaks, from its ACP
 * `agentCapabilities._meta.gg`. Carried on `ProviderCapabilities.extensions`;
 * absent = an older daemon or an agent with none, so show none of these UIs.
 */
export const ProviderExtensions = z.object({
  queue: z.boolean().optional(),
  askUser: z.boolean().optional(),
  goals: z.boolean().optional(),
  planReview: z.boolean().optional(),
  autopilot: z.boolean().optional(),
  checklist: z.boolean().optional(),
});

/**
 * A live voice conversation, GPT-Live over WebRTC.
 *
 * The audio never touches pew2: the phone's microphone and speaker talk to
 * OpenAI directly over WebRTC. What pew2 carries is the handshake, and the
 * handshake has to come through the daemon because only the daemon holds the
 * OpenAI API key. The phone makes an SDP offer, the daemon posts it to
 * `POST /v1/live/sessions` with the key and the session configuration, and the
 * SDP answer comes back. The key never leaves the desktop, and the relay only
 * ever sees sealed frames.
 *
 * The daemon then attaches to the same live session over a server-side
 * "sideband" WebSocket and runs the conversation's tools itself: starting and
 * prompting coding agents, answering their approvals, reading back what they
 * said. That is why the phone needs no tool logic, and why changing how the
 * assistant behaves is a daemon release rather than an App Store review.
 *
 * Additive, not a `WIRE_VERSION` bump: an older daemon answers `voice.start`
 * with `unknown_message`, and an older app never sends it because it never
 * sees `voice` on the provider announcement.
 */

/** Ceiling on an SDP offer. Real offers are a few KB; this stops a junk frame. */
export const MAX_SDP_BYTES = 64 * 1024;

/** App -> daemon. Start a live voice conversation from this WebRTC offer. */
export const VoiceStart = z.object({
  t: z.literal("voice.start"),
  /** Echoed on `voice.answer`. */
  requestId: z.string().min(1),
  /** The phone's SDP offer, with ICE gathering complete. */
  sdp: z.string().min(1).max(MAX_SDP_BYTES),
  /**
   * The conversation on screen, if any: where coding work goes by default
   * ("ask it to fix the tests" means *this* conversation).
   */
  sessionId: z.string().optional(),
  /**
   * The agent and project chosen on screen when no conversation exists yet,
   * so "start on the login bug" lands where the user was looking. `cwd` is
   * honoured only through `knownProject()`, like every client-named path.
   */
  providerId: z.string().optional(),
  cwd: z.string().optional(),
});

/** Daemon -> app, as a reply. The SDP answer, or why there is none. */
export const VoiceAnswer = z.object({
  t: z.literal("voice.answer"),
  requestId: z.string(),
  /** OpenAI's live session id, used to stop it and to match `voice.status`. */
  liveSessionId: z.string().optional(),
  /**
   * What a minute of this call costs, so the phone can show a running "about"
   * figure. Absent on older daemons: the phone shows only the elapsed time.
   * An estimate either way, since delegation turns add a little on top.
   */
  voiceRatePerMinuteUsd: z.number().positive().optional(),
  /** Apply as the remote description. Absent when `error` explains why not. */
  sdp: z.string().optional(),
  error: z.string().optional(),
});

/**
 * App -> daemon. End a live conversation.
 *
 * The phone also sends `session.close` on its own data channel; this is the
 * belt to that, for when the data channel is already gone, so the daemon
 * closes its sideband and stops the clock on a session nobody is listening to.
 */
export const VoiceStop = z.object({
  t: z.literal("voice.stop"),
  liveSessionId: z.string(),
});

/**
 * Daemon -> every client. What the voice assistant's backend is doing.
 *
 * Broadcast, because it happens long after the request that started it (a
 * coding turn can run for minutes), and clients ignore a `liveSessionId` they
 * did not start. `sessionId` is the pew2 conversation the coding work went to,
 * so the phone can open it and the transcript shows the work afterwards.
 */
export const VoiceStatus = z.object({
  t: z.literal("voice.status"),
  liveSessionId: z.string(),
  state: z.enum([
    /** Sideband attached; tools are live. */
    "ready",
    /** A coding agent is running a turn the assistant started. */
    "agent_working",
    /** That agent is blocked on an approval. */
    "agent_waiting",
    /** That turn finished; the assistant has been told. */
    "agent_done",
    /** The live session ended, for any reason. */
    "closed",
    /** Something failed; `detail` says what, in words for a person. */
    "error",
  ]),
  sessionId: z.string().optional(),
  providerId: z.string().optional(),
  /** Project folder name, for "Claude Code is working in pew2". */
  folder: z.string().optional(),
  detail: z.string().optional(),
});

export const ErrorMessage = z.object({
  t: z.literal("error"),
  code: z.string(),
  message: z.string(),
  sessionId: z.string().optional(),
});

/**
 * A sealed message. Everything with user content travels as one of these.
 *
 * `sid` and `seq` are cleartext headers bound into the AEAD as associated data,
 * so changing either invalidates the frame. The relay neither stores nor replays
 * session events. The daemon owns the ordered session log and answers a
 * reconnecting phone's cursors itself.
 *
 * The definitive shape lives in `crypto.ts`, which is what actually seals and
 * opens these; this mirror exists so a message can be validated on arrival
 * alongside every other frame.
 */
export const Envelope = z.object({
  t: z.literal("e"),
  sid: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  /** Monotonic per connection per sender. Replay protection within a session. */
  ctr: z.number().int().nonnegative(),
  /** base64url nonce. */
  n: z.string(),
  /** base64url ciphertext, including the Poly1305 tag. */
  ct: z.string(),
});

export const ClientMessage = z.discriminatedUnion("t", [
  Hello,
  Envelope,
  ProviderCapabilitiesRequest,
  ProviderSessionsRequest,
  SetProviderConfig,
  SetSessionConfig,
  StartSession,
  ResumeSession,
  Prompt,
  Cancel,
  PermissionReply,
  ImageRequest,
  VideoRequest,
  WorkspaceRequest,
  WorkspacesRequest,
  PushRegister,
  QueueCancel,
  AskReply,
  GoalsRequest,
  GoalCreate,
  GoalAction,
  PlanDecide,
  AutopilotSet,
  ChecklistRequest,
  VoiceStart,
  VoiceStop,
  DashRequest,
  CallbackAck,
  MediaAck,
]);

export const ServerMessage = z.discriminatedUnion("t", [
  Ready,
  Envelope,
  ProviderAnnounce,
  ProviderCapabilities,
  ProviderConfig,
  ProviderSessions,
  SessionEvent,
  SessionIdle,
  CallbackDue,
  Replay,
  ImageData,
  VideoData,
  MediaPart,
  Workspace,
  Workspaces,
  DeviceJoined,
  SessionQueue,
  Goals,
  GoalResult,
  GoalState,
  PlanState,
  AutopilotState,
  Checklist,
  VoiceAnswer,
  VoiceStatus,
  Dash,
  ErrorMessage,
]);

export type QueuedMessage = z.output<typeof QueuedMessage>;
export type SessionQueue = z.output<typeof SessionQueue>;
export type QueueCancel = z.output<typeof QueueCancel>;
export type AskOption = z.output<typeof AskOption>;
export type AskQuestion = z.output<typeof AskQuestion>;
export type AskRequest = z.output<typeof AskRequest>;
export type AskResult = z.output<typeof AskResult>;
export type AskReply = z.output<typeof AskReply>;
export type GoalStatus = z.output<typeof GoalStatus>;
export type GoalContextItem = z.output<typeof GoalContextItem>;
export type GoalSummary = z.output<typeof GoalSummary>;
export type GoalsRequest = z.output<typeof GoalsRequest>;
export type Goals = z.output<typeof Goals>;
export type DashRequest = z.output<typeof DashRequest>;
export type Dash = z.output<typeof Dash>;
export type GoalCreate = z.output<typeof GoalCreate>;
export type GoalAction = z.output<typeof GoalAction>;
export type GoalResult = z.output<typeof GoalResult>;
export type GoalWorker = z.output<typeof GoalWorker>;
export type GoalState = z.output<typeof GoalState>;

export type SetProviderConfig = z.output<typeof SetProviderConfig>;
export type SetSessionConfig = z.output<typeof SetSessionConfig>;
export type Hello = z.output<typeof Hello>;
export type Envelope = z.output<typeof Envelope>;
export type ProviderAnnounce = z.output<typeof ProviderAnnounce>;
export type ConfigOption = z.output<typeof ConfigOption>;
export type AgentSession = z.output<typeof AgentSession>;
export type ResumeSession = z.output<typeof ResumeSession>;
export type ProviderCapabilitiesRequest = z.output<typeof ProviderCapabilitiesRequest>;
export type ProviderCapabilities = z.output<typeof ProviderCapabilities>;
export type ProviderConfig = z.output<typeof ProviderConfig>;
export type AgentProject = z.output<typeof AgentProject>;
export type ProviderSessionsRequest = z.output<typeof ProviderSessionsRequest>;
export type ProviderSessions = z.output<typeof ProviderSessions>;
export type StartSession = z.output<typeof StartSession>;
export type PromptAttachment = z.output<typeof PromptAttachment>;
export type Prompt = z.output<typeof Prompt>;
export type Cancel = z.output<typeof Cancel>;
export type PermissionReply = z.output<typeof PermissionReply>;
export type ImageRequest = z.output<typeof ImageRequest>;
export type ImageData = z.output<typeof ImageData>;
export type VideoRequest = z.output<typeof VideoRequest>;
export type VideoData = z.output<typeof VideoData>;
export type MediaPart = z.output<typeof MediaPart>;
export type MediaAck = z.output<typeof MediaAck>;
export type WorkspaceRequest = z.output<typeof WorkspaceRequest>;
export type Workspace = z.output<typeof Workspace>;
export type SessionEvent = z.output<typeof SessionEvent>;
export type Replay = z.output<typeof Replay>;
export type SessionIdle = z.output<typeof SessionIdle>;
export type CallbackDue = z.output<typeof CallbackDue>;
export type CallbackAck = z.output<typeof CallbackAck>;
export type PushRegister = z.output<typeof PushRegister>;
export type DeviceJoined = z.output<typeof DeviceJoined>;
export type VoiceStart = z.output<typeof VoiceStart>;
export type VoiceAnswer = z.output<typeof VoiceAnswer>;
export type VoiceStop = z.output<typeof VoiceStop>;
export type VoiceStatus = z.output<typeof VoiceStatus>;
export type WorkspaceEntry = z.output<typeof WorkspaceEntry>;
export type Workspaces = z.output<typeof Workspaces>;
export type ClientMessage = z.output<typeof ClientMessage>;
export type ServerMessage = z.output<typeof ServerMessage>;
export type PlanState = z.output<typeof PlanState>;
export type PlanDecide = z.output<typeof PlanDecide>;
export type AutopilotState = z.output<typeof AutopilotState>;
export type AutopilotSet = z.output<typeof AutopilotSet>;
export type ChecklistItemRow = z.output<typeof ChecklistItemRow>;
export type ChecklistRequest = z.output<typeof ChecklistRequest>;
export type Checklist = z.output<typeof Checklist>;
export type ProviderExtensions = z.output<typeof ProviderExtensions>;
