/**
 * `pew2 voice key|status|off`: the OpenAI key behind the phone's voice button.
 *
 * The key is read from stdin when piped, or from a prompt that does not echo.
 * It is written to `voice.json` owner-only and never printed, not even in part.
 */
import {
  looksLikeApiKey,
  readVoiceConfig,
  removeVoiceKey,
  voiceConfigPath,
  writeVoiceKey,
} from "../voice/config.js";
import { checkKey, type FetchLike } from "../voice/openai.js";
import { readMonthSeconds } from "../voice/budget.js";

/** Read a line without echoing it. Raw mode, so nothing reaches the terminal. */
async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          done();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          done();
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** Store a key. Exported apart from the stdin handling so it can be tested. */
export async function saveVoiceKey(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; message: string }> {
  const key = raw.trim();
  if (!looksLikeApiKey(key)) {
    return { ok: false, message: "That does not look like an OpenAI API key (they start with sk-). Nothing was saved." };
  }
  await writeVoiceKey(key, env);
  return {
    ok: true,
    message: `Saved the OpenAI key to ${voiceConfigPath(env)}. Reconnect the app to use voice.`,
  };
}

export async function voiceStatus(
  env: NodeJS.ProcessEnv = process.env,
  options: { check?: boolean; fetch?: FetchLike } = {},
) {
  const config = await readVoiceConfig(env);
  const check =
    options.check && config.apiKey ? await checkKey(config.apiKey, options.fetch) : undefined;
  return {
    ok: config.apiKey !== undefined && (check?.ok ?? true),
    configured: config.apiKey !== undefined,
    source: config.source,
    voice: config.voice,
    backendModel: config.backendModel,
    maxMinutes: config.maxMinutes,
    monthlyCapUsd: config.monthlyCapUsd,
    /** This calendar month's spend so far, at the configured rate. */
    monthSpentUsd: ((await readMonthSeconds(env)) / 60) * config.voiceRatePerMinuteUsd,
    path: voiceConfigPath(env),
    check: check?.message,
  };
}

export async function cmdVoice(command: string | undefined, flags: Set<string>): Promise<number> {
  const json = flags.has("--json");
  const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value, null, 2) : text);

  if (command === "key") {
    let raw: string;
    try {
      raw = process.stdin.isTTY ? await promptHidden("OpenAI API key (hidden): ") : await readPiped();
    } catch (error) {
      console.error((error as Error).message);
      return 1;
    }
    const result = await saveVoiceKey(raw);
    out(result, result.message);
    return result.ok ? 0 : 1;
  }

  if (command === "off") {
    const removed = await removeVoiceKey();
    const message = removed
      ? "Removed the OpenAI key. Voice is off on the phone after it reconnects."
      : "No OpenAI key was stored.";
    out({ ok: true, removed, message }, message);
    const config = await readVoiceConfig();
    if (config.source === "env") {
      console.error("OPENAI_API_KEY is still set in this environment, so a daemon started from it keeps voice on.");
    }
    return 0;
  }

  if (command === "status") {
    const status = await voiceStatus(process.env, { check: flags.has("--check") });
    const lines = status.configured
      ? [
          `Voice: configured (key from ${status.source === "env" ? "OPENAI_API_KEY" : status.path})`,
          `Voice: ${status.voice}   Backend model: ${status.backendModel}   Max ${status.maxMinutes} min`,
          `This month: $${status.monthSpentUsd.toFixed(2)} of $${status.monthlyCapUsd.toFixed(2)}`,
          ...(status.check ? [status.check] : ["Add --check to test the key against OpenAI."]),
        ]
      : ["Voice: not configured. Run pew2 voice key to add an OpenAI API key."];
    out(status, lines.join("\n"));
    return status.ok ? 0 : 1;
  }

  console.error("Usage: pew2 voice key | status [--check] [--json] | off");
  return 1;
}
