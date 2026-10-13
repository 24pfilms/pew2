/**
 * Has the phone moved to a different network?
 *
 * Fed every NetInfo update. Only a real move counts: a different transport
 * (wifi to cellular), a different address on the same one (a new access
 * point), or coming back after having none. NetInfo also reports reachability
 * flickers and detail refreshes that change nothing about which network the
 * socket is bound to, and reconnecting on those would cost a working
 * connection for no reason.
 *
 * Losing the network is not itself a change worth acting on: there is nothing
 * to reconnect over. The change is acted on when a network appears.
 *
 * Pure, with no `react-native` import, so it is tested without the native
 * module.
 */
export interface NetworkSnapshot {
  type: string;
  isConnected: boolean | null;
  details: unknown;
}

function identity(state: NetworkSnapshot): string | undefined {
  if (state.isConnected !== true) return undefined;
  const address = (state.details as { ipAddress?: unknown } | null)?.ipAddress;
  return `${state.type}|${typeof address === "string" ? address : ""}`;
}

export class NetworkChange {
  private last: string | undefined;
  private seen = false;

  /** True when this update moved the phone onto a different network. */
  next(state: NetworkSnapshot): boolean {
    const current = identity(state);
    // The first update is the network the app started on, not a move.
    if (!this.seen) {
      this.seen = true;
      this.last = current;
      return false;
    }
    const moved = current !== undefined && current !== this.last;
    this.last = current;
    return moved;
  }
}
