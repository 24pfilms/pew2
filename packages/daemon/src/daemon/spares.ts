/**
 * Warm spares and the background capability refresh that boots them.
 *
 * A spare is an already-booted agent process, parked by the capability probe
 * so the next conversation adopts it instead of paying the spawn. See
 * `DaemonState.spares` for how they are keyed and bounded.
 */
import type { LoadedProvider } from "../providers/registry.js";
import { connectProvider, type AcpSessionHandle } from "../acp/connect.js";
import { DaemonState } from "./state.js";
import { EMPTY_CAPABILITIES, GG_GOALS_ID, ORCA_GOALS_ENGINE_ID, readExtensions } from "./types.js";

export abstract class DaemonSpares extends DaemonState {
  /**
   * Boot a provider in the background, refresh its cache, and push the result.
   * A failed refresh is silent: the cached answer stays in place.
   */
  protected async revalidate(providerId: string) {
    // Recorded before the refresh rather than after it, so a provider that fails
    // or hangs is retried on the next interval instead of on the very next ask.
    this.markProbed(providerId, Date.now());
    // Corrected on the way out, like every other capability answer: the refresh
    // reports the agent's defaults, and pushing those would overwrite a correct
    // pill with "Default" seconds after the app opened.
    const fresh = await this.capabilitiesFor(providerId, { refresh: true });
    if (fresh === EMPTY_CAPABILITIES) return;
    // OrcaGoals' engine is never shown on its own: what it refreshed is the
    // Goals list. Pushing its raw list filed every goal chat under an agent the
    // app was never told about.
    if (providerId === ORCA_GOALS_ENGINE_ID) {
      const goals = await this.capabilitiesFor(GG_GOALS_ID);
      if (goals !== EMPTY_CAPABILITIES) this.send({ t: "provider.capabilities", providerId: GG_GOALS_ID, ...goals });
      return;
    }
    // The app folds this into the drawer exactly like an answer to its own
    // request, so a stale list corrects itself moments after opening.
    this.send({ t: "provider.capabilities", providerId, ...fresh });
  }

  /**
   * Boot a spare in a specific directory, in the background.
   *
   * Separate from `warmProvider`, which exists to refresh capabilities and can
   * only ever warm the probe's own workspace.
   */
  protected async warmSpareFor(provider: LoadedProvider, cwd: string): Promise<void> {
    if (this.spares.has(DaemonSpares.spareKey(provider.manifest.id, cwd))) return;
    try {
      const handle = await connectProvider({
        provider,
        cwd,
        onUpdate: () => {},
        onPermissionRequest: () => {},
      });
      this.stashSpare(provider.manifest.id, handle, cwd);
    } catch {
      // Best effort. The next conversation here spawns cold, which is the
      // behaviour this is trying to improve on rather than depend on.
    }
  }

  /**
   * Refresh a provider's capabilities in the background, once.
   *
   * Deduplicated here rather than in each caller: the staleness check below and
   * the spare boot both want the same refresh, and running two means spawning
   * the agent twice to ask it the same question.
   */
  protected refreshCapabilities(providerId: string): Promise<void> {
    const existing = this.refreshing.get(providerId);
    if (existing) return existing;
    const run = this.revalidate(providerId)
      .catch(() => {
        // A failed refresh is silent by design: the cached answer stands.
      })
      .finally(() => {
        if (this.refreshing.get(providerId) === run) this.refreshing.delete(providerId);
      });
    this.refreshing.set(providerId, run);
    return run;
  }

  /** Newest wins, so a stale cache file cannot rewind a live probe. */
  protected markProbed(providerId: string, at: number) {
    if ((this.probedAt.get(providerId) ?? 0) < at) this.probedAt.set(providerId, at);
  }

  /**
   * Kick a background refresh if what we are about to serve is old.
   *
   * Never awaited. The caller is answered from the cached probe at once and the
   * fresh list arrives moments later as a `provider.capabilities` push, which
   * clients already fold in exactly like an answer to their own request.
   */
  protected revalidateIfStale(providerId: string) {
    const at = this.probedAt.get(providerId);
    if (at !== undefined && Date.now() - at < DaemonState.PROBE_TTL_MS) return;
    void this.refreshCapabilities(providerId);
  }

  protected warmProvider(providerId: string): Promise<void> {
    // Nothing is warmed for an agent that is off. Without this the daemon would
    // still boot a process for it in the background, which is most of what
    // turning it off was meant to avoid.
    if (!this.isEnabled(providerId)) return Promise.resolve();
    // A GG Goals process belongs to one goal folder, and a spare is parked at
    // the default workspace — no goal could ever adopt it, so it would only be
    // a second idle GG Coder. Goal conversations open cold.
    if (providerId === GG_GOALS_ID) return Promise.resolve();
    // Any warm process for this provider is enough to skip the boot; the
    // directory match is `takeSpare`'s business, not this one's.
    if (this.hasSpare(providerId)) {
      // A spare is already waiting, so anyone armed by a probe that took the
      // disk-cache path has nothing left to wait for. Releasing here is what
      // stops `awaitSpare` blocking on a boot that will never be started.
      this.spareReady.get(providerId)?.announce();
      this.spareReady.delete(providerId);
      return Promise.resolve();
    }
    const existing = this.warming.get(providerId);
    if (existing) return existing;
    // Armed before the probe starts, not inside it: `probeProvider` awaits the
    // disk cache first, so a tap arriving in that window would find no promise
    // to wait on and spawn a second process alongside this one.
    this.armSpare(providerId);
    const warming = this.refreshCapabilities(providerId).finally(() => {
      if (this.warming.get(providerId) === warming) this.warming.delete(providerId);
      // Release anyone still waiting; a finished boot either left a spare or
      // failed, and both answers are "stop waiting".
      this.spareReady.get(providerId)?.announce();
      this.spareReady.delete(providerId);
    });
    this.warming.set(providerId, warming);
    return warming;
  }

  /** The pending boot for a provider, created on first use. */
  protected armSpare(providerId: string) {
    const existing = this.spareReady.get(providerId);
    if (existing) return existing;
    let announce!: () => void;
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const entry = { ready, announce };
    this.spareReady.set(providerId, entry);
    return entry;
  }

  /** Wait only for a warm process, never for the history probe around it. */
  protected async awaitSpare(providerId: string): Promise<void> {
    await this.spareReady.get(providerId)?.ready;
  }

  /**
   * The directories a provider currently has a warm process in.
   *
   * Exposed for tests, which previously reached into the private map by
   * provider id \u2014 so keying spares by directory broke three of them without
   * any behaviour changing. An accessor keeps them honest about what they are
   * really asserting.
   */
  spareDirs(providerId: string): string[] {
    const prefix = `${providerId}\u0000`;
    return [...this.spares.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, spare]) => spare.cwd);
  }

  /** Whether any warm process exists for a provider, in any directory. */
  protected hasSpare(providerId: string): boolean {
    for (const key of this.spares.keys()) if (key.startsWith(`${providerId}\u0000`)) return true;
    return false;
  }

  /** The map key for a warm process. */
  protected static spareKey(providerId: string, cwd: string): string {
    return `${providerId}\u0000${cwd}`;
  }

  protected noteExtensions(providerId: string, handle: AcpSessionHandle | undefined): void {
    const ext = readExtensions(handle?.ggCapabilities as Record<string, unknown> | undefined);
    if (ext) this.knownExtensions.set(providerId, ext);
  }

  /**
   * Close a parked process, or, while a call is still running on it, as soon as
   * that call is done. Only for spares: a session's own process closes at once,
   * because closing it is what ends the session.
   */
  protected retire(handle: AcpSessionHandle): void {
    if ((this.borrowed.get(handle) ?? 0) > 0) this.retiring.add(handle);
    else handle.close();
  }

  /** Run a call on a borrowed process, keeping it alive until the call settles. */
  protected async onBorrowed<T>(handle: AcpSessionHandle, call: (handle: AcpSessionHandle) => Promise<T>): Promise<T> {
    this.borrowed.set(handle, (this.borrowed.get(handle) ?? 0) + 1);
    try {
      return await call(handle);
    } finally {
      const left = (this.borrowed.get(handle) ?? 1) - 1;
      if (left > 0) this.borrowed.set(handle, left);
      else {
        this.borrowed.delete(handle);
        if (this.retiring.delete(handle)) handle.close();
      }
    }
  }

  protected stashSpare(providerId: string, handle: AcpSessionHandle, cwd: string) {
    this.noteExtensions(providerId, handle);
    const key = DaemonSpares.spareKey(providerId, cwd);
    const old = this.spares.get(key);
    if (old) {
      clearTimeout(old.timer);
      this.retire(old.handle);
      // Removed as well as closed, so the eviction pass below does not find it
      // and close the same process a second time.
      this.spares.delete(key);
    }

    // Bounded per provider, oldest first. Each spare is a live agent process
    // holding memory and a model connection, so "keep one per project" cannot
    // mean "keep one per project the user has ever opened".
    const mine = [...this.spares.keys()].filter((k) => k.startsWith(`${providerId}\u0000`));
    while (mine.length >= DaemonState.MAX_SPARES_PER_PROVIDER) {
      const evict = mine.shift()!;
      const spare = this.spares.get(evict);
      if (spare) {
        clearTimeout(spare.timer);
        this.retire(spare.handle);
        this.spares.delete(evict);
      }
    }

    const timer = setTimeout(() => {
      this.spares.delete(key);
      this.retire(handle);
    }, DaemonState.SPARE_TTL_MS);
    // The timer must not keep the daemon process alive on its own.
    timer.unref?.();
    this.spares.set(key, { handle, timer, cwd, providerId });
  }

  /**
   * A warm process for this provider, but only if it is already in the right
   * directory.
   *
   * The cwd check is the whole point. ACP passes a `cwd` with every
   * `session/new`, and well-behaved agents honour it — but several do not, and
   * simply run wherever their process was started. Adopting one of those for a
   * different project produced an agent that looked connected and correct while
   * reading and writing entirely the wrong tree, which is about the worst
   * failure this daemon could have.
   *
   * A mismatch is left in place rather than closed: it may still be adopted by
   * the next session in its own project, and `SPARE_TTL_MS` reaps it otherwise.
   *
   * The cost is real and worth stating: spares are only ever booted by the
   * capability probe, which runs in `resolveWorkspace()` — the home directory
   * under launchd. A conversation opened in an actual project therefore misses
   * the warm path and pays the cold spawn. That is the right way round. A few
   * seconds of boot is a worse outcome than an agent confidently editing the
   * wrong repository, and the previous behaviour bought its speed by doing
   * exactly that.
   */
  protected takeSpare(providerId: string, cwd: string): AcpSessionHandle | undefined {
    const key = DaemonSpares.spareKey(providerId, cwd);
    const spare = this.spares.get(key);
    if (!spare) return undefined;
    clearTimeout(spare.timer);
    this.spares.delete(key);
    return spare.handle;
  }
}
