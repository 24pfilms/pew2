/**
 * The two calls pew2 makes to OpenAI for a live voice conversation: create the
 * session from the phone's SDP offer, and attach the sideband socket.
 *
 * Every failure becomes a sentence for a person. The key is only ever put in an
 * Authorization header; it is never part of a message, a log line or an error.
 */
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

export const OPENAI_BASE = "https://api.openai.com/v1";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A stable, non-reversible id for this machine, sent as
 * `OpenAI-Safety-Identifier` so abuse can be attributed without naming anyone.
 */
export function safetyIdentifier(): string {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (some containers): the host alone still distinguishes.
  }
  return createHash("sha256").update(`pew2:${hostname()}:${user}`).digest("hex");
}

export function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "OpenAI-Safety-Identifier": safetyIdentifier(),
  };
}

/** What a failed OpenAI call means for the person holding the phone. */
export function describeStatus(status: number): string {
  if (status === 401) {
    return "OpenAI did not accept the API key. Run pew2 voice key on your computer with a valid key.";
  }
  if (status === 403 || status === 404) {
    return "This OpenAI project does not have GPT-Live access. Check the project the key belongs to.";
  }
  if (status === 429) {
    return "OpenAI is rate limiting this key, or its quota is used up. Try again shortly or check billing.";
  }
  if (status >= 500) return "OpenAI had a problem starting the voice session. Try again in a moment.";
  return `OpenAI refused the voice session (HTTP ${status}).`;
}

export type CreateResult =
  | { ok: true; liveSessionId: string; sdp: string }
  | { ok: false; error: string };

export async function createLiveSession(options: {
  apiKey: string;
  sdp: string;
  session: Record<string, unknown>;
  fetch?: FetchLike;
  signal?: AbortSignal;
}): Promise<CreateResult> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  let response: Response;
  try {
    response = await doFetch(`${OPENAI_BASE}/live/sessions`, {
      method: "POST",
      headers: { ...authHeaders(options.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        session: options.session,
        transport: { type: "webrtc", sdp: options.sdp },
      }),
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    return {
      ok: false,
      error: "Your computer could not reach OpenAI. Check its internet connection.",
    };
  }
  if (!response.ok) {
    // The body may explain more, but it is logged on this machine only.
    const body = await response.text().catch(() => "");
    console.error(`[voice] session create failed: HTTP ${response.status} ${body.slice(0, 500).replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-[redacted]")}`);
    return { ok: false, error: describeStatus(response.status) };
  }
  const body = (await response.json().catch(() => undefined)) as
    | { session?: { id?: unknown }; transport?: { sdp?: unknown } }
    | undefined;
  const id = body?.session?.id;
  const sdp = body?.transport?.sdp;
  if (typeof id !== "string" || typeof sdp !== "string") {
    return { ok: false, error: "OpenAI answered the voice session in a shape pew2 does not recognise." };
  }
  return { ok: true, liveSessionId: id, sdp };
}

export function attachUrl(liveSessionId: string): string {
  return `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(liveSessionId)}/attach`;
}

/** A cheap authenticated call, for `pew2 voice status --check`. */
export async function checkKey(apiKey: string, doFetch: FetchLike = (u, i) => fetch(u, i)) {
  try {
    const response = await doFetch(`${OPENAI_BASE}/models`, {
      method: "GET",
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { ok: true as const, message: "OpenAI accepted the key." };
    return { ok: false as const, message: describeStatus(response.status) };
  } catch {
    return { ok: false as const, message: "Could not reach OpenAI from this computer." };
  }
}
