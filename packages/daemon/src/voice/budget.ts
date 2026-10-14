/**
 * This month's voice spend, kept on the computer, so a monthly cap holds across
 * calls, phones and daemon restarts.
 *
 * GPT-Live bills every second a session is open, silence included, so the
 * ledger counts seconds and the cap is turned into seconds at the configured
 * rate. Months are the computer's local calendar months: the cap resets on the
 * 1st, which is when the user expects it to.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "../providers/registry.js";
import { writeFileAtomic } from "../atomic-file.js";

/** What a month of voice may cost when `voice.json` does not say. */
export const DEFAULT_MONTHLY_CAP_USD = 10;

interface Ledger {
  /** `YYYY-MM`, local time. A ledger from another month counts as empty. */
  month: string;
  seconds: number;
}

export function monthKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function voiceUsagePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userProvidersDir(env)), "voice-usage.json");
}

/** Seconds of voice used this month. */
export async function readMonthSeconds(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<number> {
  try {
    const ledger = JSON.parse(await readFile(voiceUsagePath(env), "utf8")) as Partial<Ledger>;
    return ledger.month === monthKey(now) && typeof ledger.seconds === "number" && ledger.seconds > 0
      ? ledger.seconds
      : 0;
  } catch {
    // No ledger yet, or an unreadable one: nothing recorded this month.
    return 0;
  }
}

/** Add a finished call's seconds to this month. Callers serialise their writes. */
export async function addMonthSeconds(
  seconds: number,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<number> {
  const total = (await readMonthSeconds(env, now)) + Math.max(0, seconds);
  const path = voiceUsagePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify({ month: monthKey(now), seconds: total } satisfies Ledger, null, 2)}\n`);
  return total;
}

/** Seconds of voice the cap still allows this month. */
export function secondsLeft(capUsd: number, ratePerMinuteUsd: number, usedSeconds: number): number {
  return Math.max(0, Math.floor((capUsd / ratePerMinuteUsd) * 60 - usedSeconds));
}

/** "1 November", for telling someone when a spent cap comes back. */
export function nextResetLabel(now: Date = new Date()): string {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `1 ${next.toLocaleString("en-GB", { month: "long" })}`;
}

/** The words a phone shows when this month's voice budget is spent. */
export function budgetSpentReason(capUsd: number, now: Date = new Date()): string {
  return `This month's $${capUsd.toFixed(2)} voice budget is used up. It resets on ${nextResetLabel(now)}.`;
}
