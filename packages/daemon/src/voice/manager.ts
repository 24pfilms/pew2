/**
 * Every live voice conversation this daemon is running.
 *
 * `voice.start` lands here from the shared handler: create the session with
 * OpenAI from the phone's SDP offer, answer, then attach the sideband that runs
 * the tools. Capped, clocked and closed with the daemon.
 */
import { basename } from "node:path";
import type { wire } from "@pew2/protocol";
import type { VoiceHost, VoiceObservation } from "./host.js";
import { NO_KEY_REASON, readVoiceConfig, type VoiceConfig } from "./config.js";
import { addMonthSeconds, budgetSpentReason, readMonthSeconds, secondsLeft } from "./budget.js";
import { attachUrl, authHeaders, createLiveSession, type FetchLike } from "./openai.js";
import { BACKEND_INSTRUCTIONS, LIVE_INSTRUCTIONS, TOOLS, speakable, tail } from "./prompts.js";
import { defaultCreateSocket, LiveVoiceSession, type CreateSocket, type Target } from "./session.js";

/** Live voice sessions at once. A phone redialling replaces the oldest. */
export const MAX_LIVE_VOICE = 2;

export type VoiceAvailability = { available: boolean; reason?: string };

export class VoiceManager {
  private readonly live = new Map<string, LiveVoiceSession>();
  private availability: VoiceAvailability = { available: false, reason: NO_KEY_REASON };
  /**
   * Ledger writes, one after another: two calls ending together would
   * otherwise both read the old total and one call's minutes would vanish.
   */
  private ledger: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: VoiceHost,
    private readonly io: { fetch?: FetchLike; createSocket?: CreateSocket } = {},
  ) {}

  /** For the provider announcement. Kept fresh by `refresh()`. */
  get status(): VoiceAvailability {
    return this.availability;
  }

  /** Re-read the key, so `pew2 voice key` takes effect on the next connect. */
  async refresh(): Promise<VoiceAvailability> {
    await this.ledger;
    return this.assess();
  }

  /**
   * Availability from the key and this month's ledger as they stand.
   *
   * Never waits on `ledger` itself: a finished call runs this from inside that
   * chain, and waiting there would wait on itself.
   */
  private async assess(): Promise<VoiceAvailability> {
    const config = await readVoiceConfig(this.host.env);
    if (!config.apiKey) {
      this.availability = { available: false, reason: NO_KEY_REASON };
    } else if ((await this.budgetSeconds(config)) <= 0) {
      this.availability = { available: false, reason: budgetSpentReason(config.monthlyCapUsd) };
    } else {
      this.availability = { available: true };
    }
    return this.availability;
  }

  sessions(): LiveVoiceSession[] {
    return [...this.live.values()];
  }

  async start(message: wire.VoiceStart): Promise<wire.VoiceAnswer> {
    const config = await readVoiceConfig(this.host.env);
    const answer = (fields: Partial<wire.VoiceAnswer>): wire.VoiceAnswer => ({
      t: "voice.answer",
      requestId: message.requestId,
      ...fields,
    });
    if (!config.apiKey) {
      return answer({ error: "No OpenAI API key on your computer yet. Run pew2 voice key there to add one." });
    }
    // Checked before OpenAI is asked for anything: a spent month must not
    // open even one more billed second. A call that just ended is counted first.
    await this.ledger;
    const budget = await this.budgetSeconds(config);
    if (budget <= 0) return answer({ error: budgetSpentReason(config.monthlyCapUsd) });

    const target = await this.initialTarget(message);
    const created = await createLiveSession({
      apiKey: config.apiKey,
      sdp: message.sdp,
      session: this.sessionConfig(config, target),
      fetch: this.io.fetch,
    });
    if (!created.ok) return answer({ error: created.error });

    while (this.live.size >= MAX_LIVE_VOICE) {
      const oldest = this.live.values().next().value;
      if (!oldest) break;
      this.live.delete(oldest.liveSessionId);
      void oldest.close("a newer call");
    }

    const openedAt = Date.now();
    const session = new LiveVoiceSession(created.liveSessionId, this.host, target, {
      // Whichever comes first: the per-call limit or what is left of the month.
      maxMs: Math.min(config.maxMinutes * 60_000, budget * 1000),
      onFinished: (s) => {
        if (this.live.get(s.liveSessionId) === s) this.live.delete(s.liveSessionId);
        // OpenAI's own count when it sent one, and never less than the time
        // the session was open: it bills silence too.
        const seconds = Math.max(s.usageSeconds, (Date.now() - openedAt) / 1000);
        this.ledger = this.ledger
          .then(() => addMonthSeconds(seconds, this.host.env))
          .then(() => this.assess())
          .catch((error: unknown) => console.error("[voice] could not record call minutes:", error));
      },
    });
    this.live.set(created.liveSessionId, session);
    session.attach(
      this.io.createSocket ?? defaultCreateSocket,
      attachUrl(created.liveSessionId),
      authHeaders(config.apiKey),
    );
    return answer({
      liveSessionId: created.liveSessionId,
      sdp: created.sdp,
      voiceRatePerMinuteUsd: config.voiceRatePerMinuteUsd,
    });
  }

  /** Seconds this month's cap still allows, from the ledger as it stands. */
  private async budgetSeconds(config: VoiceConfig): Promise<number> {
    const used = await readMonthSeconds(this.host.env);
    return secondsLeft(config.monthlyCapUsd, config.voiceRatePerMinuteUsd, used);
  }

  async stop(liveSessionId: string): Promise<void> {
    await this.live.get(liveSessionId)?.close("the phone (hang-up pressed)");
  }

  observe(observation: VoiceObservation) {
    for (const session of this.live.values()) session.observe(observation);
  }

  closeAll() {
    for (const session of [...this.live.values()]) void session.close("pew2 shutting down");
  }

  /** Where coding work goes until the user says otherwise. */
  private async initialTarget(message: wire.VoiceStart): Promise<Target> {
    const view = message.sessionId ? this.host.session(message.sessionId) : undefined;
    if (view) {
      return {
        sessionId: view.sessionId,
        providerId: view.providerId,
        cwd: view.cwd,
        agentSessionId: view.agentSessionId,
      };
    }
    const agents = this.host.agents().filter((a) => a.available);
    const providerId =
      message.providerId && agents.some((a) => a.id === message.providerId)
        ? message.providerId
        : agents[0]?.id;
    if (!providerId) return {};
    // A client-named path only through `knownProject()`, like everywhere else.
    const cwd =
      (message.cwd ? await this.host.knownProject(providerId, message.cwd) : undefined) ??
      (await this.host.lastWorkspace(providerId));
    return { providerId, cwd };
  }

  sessionConfig(config: VoiceConfig, target: Target): Record<string, unknown> {
    return {
      model: "gpt-live-1",
      instructions: LIVE_INSTRUCTIONS,
      audio: { output: { voice: config.voice } },
      ...(this.seed(target) && { input: this.seed(target) }),
      delegation: {
        type: "responses",
        responses: {
          model: config.backendModel,
          instructions: BACKEND_INSTRUCTIONS,
          tools: TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: false,
          reasoning: { effort: "low" },
        },
      },
    };
  }

  /** A short note of what is on screen, so "how's it going?" has an answer. */
  private seed(target: Target): unknown[] | undefined {
    if (!target.providerId) return undefined;
    const agent = this.host.agents().find((a) => a.id === target.providerId)?.name ?? target.providerId;
    const lines = [
      `Context from the pew2 app, not said aloud: the current coding conversation is with ${agent}${target.cwd ? ` in the project ${basename(target.cwd)}` : ""}.`,
    ];
    const exchange = target.sessionId ? this.host.lastExchange(target.sessionId) : undefined;
    if (exchange?.request) lines.push(`The user's last request to it: ${tail(speakable(exchange.request), 600)}`);
    if (exchange?.reply) lines.push(`Its last reply ends: ${tail(speakable(exchange.reply), 1000)}`);
    return [
      { type: "message", role: "user", content: [{ type: "input_text", text: lines.join("\n") }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Understood." }] },
    ];
  }
}
