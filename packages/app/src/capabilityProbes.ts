/**
 * Which agents to ask for their conversation history, and when to ask again.
 *
 * The daemon announces its providers on every connect, and each one has to be
 * asked separately for the conversations it already has on disk. Asking on
 * every announcement would spawn a probe per agent per reconnect — and a phone
 * reconnects constantly, on every network switch and every unlock — so the ask
 * is remembered and not repeated.
 *
 * What that memory must not outlive is the connection. It used to: the set was
 * filled on the first announcement and never cleared, so an agent asked once at
 * launch was never asked again for the life of the app. A project created at
 * the desk stayed invisible on the phone until it was force-quit — not because
 * the daemon lacked it, but because nothing ever asked a second time. It also
 * stranded the in-flight set: a socket that dropped mid-request left a provider
 * marked loading, and the reconnect skipped the very request that would have
 * cleared it, so the drawer kept a skeleton for ever.
 *
 * Re-asking is cheap by design. The daemon's own probe cache is
 * stale-while-revalidate, so a repeat question is answered from cache
 * immediately and refreshed behind — the phone is not paying for an agent spawn
 * every time it changes network.
 */

/** One entry of the daemon's `providers` announcement. */
export interface AnnouncedProvider {
  id: string;
  /**
   * Whether this agent can actually run on that machine. Absent means an older
   * daemon that announced nothing, which is not a promise that it works.
   */
  available?: boolean;
}

export class CapabilityProbes {
  /** Providers already asked, on this connection. */
  private asked = new Set<string>();

  /**
   * The providers to ask right now, marked as asked in the same step.
   *
   * Unavailable agents are skipped rather than asked and refused: an agent that
   * is not installed has no history, and asking spawns nothing.
   */
  take(providers: readonly AnnouncedProvider[]): string[] {
    const next: string[] = [];
    for (const provider of providers) {
      if (!provider.available || this.asked.has(provider.id)) continue;
      this.asked.add(provider.id);
      next.push(provider.id);
    }
    return next;
  }

  /**
   * The socket dropped.
   *
   * Everything remembered describes a connection that no longer exists, so the
   * next announcement asks again — which is what makes work started at the desk
   * appear on the phone without a force-quit.
   */
  disconnected(): void {
    this.asked.clear();
  }
}
