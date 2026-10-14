/**
 * Small pieces of the ACP connection that need none of its state: the
 * handshake budget, the restore-method choice, a timeout wrapper, the stdio
 * stream bridge, and folding an unprompted selector update. Moved out of
 * `connect.ts` unchanged; its public names are re-exported from there.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { MODE_CONFIG_ID, normaliseConfigOptions, type ConfigOption } from "./connect-types.js";

/**
 * How long an agent may take to answer `initialize` before we give up.
 *
 * Deliberately generous. An `npx` provider downloads its package on first run,
 * which is genuinely minutes on a slow link for a large agent, and killing a
 * working install because it was cold would be the worse failure. This exists to
 * catch the case that never ends — a corrupt npx cache, an agent prompting for
 * login on stdin nobody is reading — not to make slow things fast.
 */
export const HANDSHAKE_TIMEOUT_MS = 180_000;

/**
 * Marks a timeout, so it is not re-wrapped as a startup failure below.
 *
 * A shared constant rather than a literal in two places: the two failures give
 * deliberately different advice — "it is stuck" versus "it died, here is what it
 * said" — and rewording one copy would silently start reporting hung agents as
 * crashed ones, pointing the user at a problem they never had.
 */
export const HANDSHAKE_TIMEOUT_MARKER = "did not respond to the ACP handshake";

/**
 * Which ACP method reopens a stored conversation.
 *
 * `session/load` replays the whole transcript through the update handler before
 * it resolves. `session/resume` restores the same agent-side context and sends
 * nothing. They are otherwise equivalent: same session id, same capabilities.
 *
 * Measured against GG Coder on one real conversation:
 *
 *   session/load     941ms   8,457 update notifications
 *   session/resume   418ms       0 update notifications
 *
 * The daemon paints every thread from its own cache before the agent is even
 * attached, so those 8,457 messages were being decoded and then dropped. Asking
 * for them was more than half the cost of reopening a conversation — which is
 * the cost the whole idle-session reaper trades against.
 *
 * @param haveHistory The caller already has the transcript on screen.
 * @param canResumeSession The agent advertised `session/resume`.
 */
export function restoreMethodFor(
  haveHistory: boolean,
  canResumeSession: boolean,
): "session/load" | "session/resume" {
  // Both conditions, and neither is optional. Without the transcript the replay
  // is the only way to draw the thread; without the capability, asking is a
  // protocol error rather than a graceful no-op.
  return haveHistory && canResumeSession ? "session/resume" : "session/load";
}

/**
 * Reject with `onTimeout()` if `promise` has not settled in `ms`.
 *
 * The message is built lazily so it can describe what was on stderr by the time
 * we gave up, rather than what was there when the wait started — which is
 * usually nothing at all.
 *
 * The timer is cleared on both paths: an un-cleared timer holds the event loop
 * open, which for a daemon means it never exits cleanly.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        // Re-rejecting with the original reason, not a wrapped Error: ACP
        // failures are JSON-RPC objects whose `data` field carries the only
        // useful explanation, and `humanError` downstream reads it. Wrapping
        // would throw that away to satisfy the rule.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
}

/**
 * Node child streams -> Web streams, which is what `ndJsonStream` expects.
 *
 * The double cast is needed because Node's `ReadableStream` generic and the DOM
 * lib's differ structurally, even though the runtime objects are identical.
 */
export function toWebStreams(child: ChildProcessWithoutNullStreams) {
  return {
    input: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    output: Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
  };
}

/**
 * The selector list after an update the agent sent unprompted, or undefined
 * when this notification does not carry one.
 *
 * Two shapes, because two protocol generations are live. `config_option_update`
 * resends the whole list and so replaces it — an option can legitimately
 * disappear, which is exactly what happens to the thinking level on a model
 * that does not support one. The legacy `current_mode_update` carries only an
 * id, so the selector synthesised from the `modes` block is edited in place.
 */
export function applyConfigUpdate(
  currentOptions: ConfigOption[],
  update: { sessionUpdate?: string; configOptions?: unknown; currentModeId?: unknown } | undefined,
): ConfigOption[] | undefined {
  if (update?.sessionUpdate === "config_option_update") {
    const announced = normaliseConfigOptions(update.configOptions);
    // An empty list is a malformed notification, not "this session has no
    // selectors": treating it as truth would blank every pill.
    return announced.length > 0 ? announced : undefined;
  }
  if (update?.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
    const modeId = update.currentModeId;
    // Agents that advertise a real `configOptions` mode entry announce it via
    // `config_option_update` above; this only touches the synthetic one, so
    // nothing changes when the session has none.
    if (!currentOptions.some((option) => option.id === MODE_CONFIG_ID)) return undefined;
    return currentOptions.map((option) =>
      option.id === MODE_CONFIG_ID ? { ...option, currentValue: modeId } : option,
    );
  }
  return undefined;
}
