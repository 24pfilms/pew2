/**
 * Where the OpenAI key for the live voice assistant comes from.
 *
 * `OPENAI_API_KEY` in the daemon's own environment wins, then `voice.json` in
 * the pew2 home. The file is the path that matters in practice: a launchd or
 * systemd daemon never sees the shell profile the key was exported in.
 *
 * The key is a secret on this machine and nowhere else. Nothing here logs it,
 * and nothing that reaches a client is ever built from it.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "../providers/registry.js";
import { writeFileAtomic } from "../atomic-file.js";
import { DEFAULT_MONTHLY_CAP_USD } from "./budget.js";

export const DEFAULT_VOICE = "vesper";
export const DEFAULT_BACKEND_MODEL = "gpt-6-luna";
export const DEFAULT_MAX_MINUTES = 30;
/** GPT-Live's published voice rate; `voiceRatePerMinuteUsd` overrides it. */
export const DEFAULT_VOICE_RATE_PER_MINUTE_USD = 0.05;

/** What `pew2 voice key` tells someone to run, in one place. */
export const NO_KEY_REASON = "Add an OpenAI API key on your computer: run pew2 voice key";

export interface VoiceConfig {
  apiKey?: string;
  /** Where the key came from, for `pew2 voice status`. Never the key itself. */
  source?: "env" | "file";
  voice: string;
  backendModel: string;
  maxMinutes: number;
  voiceRatePerMinuteUsd: number;
  /** The most a calendar month of voice may cost; calls stop there. */
  monthlyCapUsd: number;
}

interface StoredVoice {
  openaiApiKey?: string;
  voice?: string;
  backendModel?: string;
  maxMinutes?: number;
  voiceRatePerMinuteUsd?: number;
  monthlyCapUsd?: number;
}

export function voiceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userProvidersDir(env)), "voice.json");
}

/** The `sk-` shape OpenAI keys have, so a pasted wrong thing is caught early. */
export function looksLikeApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(value);
}

async function readStored(env: NodeJS.ProcessEnv): Promise<StoredVoice> {
  try {
    const parsed: unknown = JSON.parse(await readFile(voiceConfigPath(env), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as StoredVoice) : {};
  } catch {
    // Missing or corrupt reads as "no key", which is what the user sees anyway.
    return {};
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export async function readVoiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VoiceConfig> {
  const stored = await readStored(env);
  const fromEnv = text(env.OPENAI_API_KEY);
  const fromFile = text(stored.openaiApiKey);
  const minutes =
    typeof stored.maxMinutes === "number" && stored.maxMinutes > 0 && stored.maxMinutes <= 240
      ? stored.maxMinutes
      : DEFAULT_MAX_MINUTES;
  return {
    apiKey: fromEnv ?? fromFile,
    source: fromEnv ? "env" : fromFile ? "file" : undefined,
    voice: text(stored.voice) ?? DEFAULT_VOICE,
    backendModel: text(stored.backendModel) ?? DEFAULT_BACKEND_MODEL,
    maxMinutes: minutes,
    voiceRatePerMinuteUsd:
      typeof stored.voiceRatePerMinuteUsd === "number" && stored.voiceRatePerMinuteUsd > 0
        ? stored.voiceRatePerMinuteUsd
        : DEFAULT_VOICE_RATE_PER_MINUTE_USD,
    monthlyCapUsd:
      typeof stored.monthlyCapUsd === "number" && stored.monthlyCapUsd >= 0
        ? stored.monthlyCapUsd
        : DEFAULT_MONTHLY_CAP_USD,
  };
}

/** Store the key, keeping any other settings, owner-only. */
export async function writeVoiceKey(key: string, env: NodeJS.ProcessEnv = process.env) {
  const path = voiceConfigPath(env);
  await mkdir(dirname(path), { recursive: true });
  const stored = await readStored(env);
  await writeFileAtomic(path, `${JSON.stringify({ ...stored, openaiApiKey: key }, null, 2)}\n`, 0o600);
}

/** Forget the key. Other settings stay; the file goes when nothing is left. */
export async function removeVoiceKey(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = voiceConfigPath(env);
  const stored = await readStored(env);
  const had = text(stored.openaiApiKey) !== undefined;
  delete stored.openaiApiKey;
  if (Object.keys(stored).length === 0) await rm(path, { force: true });
  else await writeFileAtomic(path, `${JSON.stringify(stored, null, 2)}\n`, 0o600);
  return had;
}
