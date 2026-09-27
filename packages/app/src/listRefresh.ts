/**
 * One pull-to-refresh of the drawer, from the pull to the answer that ends it.
 *
 * A pull asks the daemon to re-probe the agent rather than answer from its
 * cache, because the point of pulling is "show me what changed at the desk".
 * With a project chosen, that project's conversations are asked for again once
 * the re-probe lands — not beside it, because the daemon answers them from the
 * list the probe reads, and asking early would return the old one.
 *
 * Only one runs at a time. Each pull boots the agent on the computer, and a
 * thumb dragging the list three times must not become three agent processes.
 *
 * Pure, like `CapabilityProbes`, so the ordering is testable without a socket.
 */
export type RefreshStep =
  /** Not the answer this refresh is waiting on. */
  | { kind: "none" }
  /** The re-probe landed; ask for this project's conversations now. */
  | { kind: "sessions"; providerId: string; cwd: string }
  /** Nothing left to wait for. */
  | { kind: "done" };

interface Waiting {
  providerId: string;
  cwd?: string;
  stage: "capabilities" | "sessions";
}

export class ListRefresh {
  private waiting: Waiting | undefined;

  get active(): boolean {
    return this.waiting !== undefined;
  }

  /**
   * Begin a refresh of `providerId`, narrowed to `cwd` when a project is chosen.
   * Returns false, changing nothing, while another is still running.
   */
  start(providerId: string, cwd: string | undefined): boolean {
    if (this.waiting) return false;
    this.waiting = { providerId, cwd, stage: "capabilities" };
    return true;
  }

  /** Feed every daemon message through; the step says what to do next. */
  answered(message: { t?: string; providerId?: string }): RefreshStep {
    const waiting = this.waiting;
    if (!waiting || message.providerId !== waiting.providerId) return { kind: "none" };

    if (waiting.stage === "capabilities" && message.t === "provider.capabilities") {
      if (waiting.cwd === undefined) {
        this.waiting = undefined;
        return { kind: "done" };
      }
      waiting.stage = "sessions";
      return { kind: "sessions", providerId: waiting.providerId, cwd: waiting.cwd };
    }
    // Matched on the agent alone, not the path: the daemon echoes the project
    // as it resolved it, which need not be the exact string the app sent.
    if (waiting.stage === "sessions" && message.t === "provider.sessions") {
      this.waiting = undefined;
      return { kind: "done" };
    }
    return { kind: "none" };
  }

  /** The socket closed or the wait ran out; no answer is coming for this one. */
  cancel(): void {
    this.waiting = undefined;
  }
}
