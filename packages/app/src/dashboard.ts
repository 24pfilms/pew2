/**
 * The OrcaZeroViva dashboard's words and numbers, kept out of the sheet.
 *
 * The snapshot lives only in the open sheet's memory: nothing here persists it,
 * so no PC data sits on the phone once the sheet or the app is closed.
 *
 * Pure and Expo-free, so `bun test` can load it.
 */
import type { wire } from "@pew2/protocol";

/** How often an open sheet asks again. */
export const DASH_REFRESH_MS = 60_000;
/** Longest the phone waits: the daemon's 5 s pipe timeout, a 1 s retry, another 5 s, and the link. */
export const DASH_REPLY_TIMEOUT_MS = 15_000;
/** Rows shown per list. */
export const DASH_LIST_ROWS = 10;

export const DASH_TEXT = {
  noReply: "Your computer didn't answer. Try again.",
  offline: "Not connected to your computer",
  oldDaemon: "Update pew2 on your computer.",
  unavailable: "Couldn't load this part.",
  noTasks: "No pending tasks.",
  noRoutines: "No routines.",
  noActivity: "Nothing yet today.",
  noChats: "No chats yet.",
  noLimit: "No daily limit",
} as const;

/**
 * Whether an error frame is a daemon too old to know `dash`. It names no
 * request, only the type ("Unknown message type 'dash'"), so the type is what
 * tells it apart from another feature's unknown frame.
 */
export function isDashUnknown(code: unknown, text: unknown): boolean {
  return code === "unknown_message" && typeof text === "string" && text.includes("'dash'");
}

export type SpendTone = "ok" | "attention" | "danger";

/** Spend against the daily limit, clamped to 0..100; undefined when there is no limit to measure against. */
export function spendPercent(totalUsd: number, limitUsd: number | null): number | undefined {
  if (limitUsd === null || !(limitUsd > 0)) return undefined;
  return Math.min(100, Math.max(0, Math.round((totalUsd / limitUsd) * 100)));
}

export function spendTone(percent: number | undefined, alertAtPercent: number): SpendTone {
  if (percent === undefined) return "ok";
  if (percent >= 100) return "danger";
  return percent >= alertAtPercent ? "attention" : "ok";
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** "just now", "5m ago", "in 3h": for activity, chats and next runs. Unparseable input reads as nothing. */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const delta = at - now;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (minutes < 1) return "just now";
  const span = minutes < 60 ? `${minutes}m` : minutes < 60 * 24 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / (60 * 24))}d`;
  return delta > 0 ? `in ${span}` : `${span} ago`;
}

/** "Last seen 14:02", in the phone's own time zone: shown over a snapshot the latest refresh could not replace. */
export function lastSeenLabel(generatedAt: number): string {
  const at = new Date(generatedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Last seen ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A due date as the person wrote it, trimmed to the day when it carries a time. */
export function dueLabel(dueDate: string | undefined): string {
  return dueDate ? `Due ${dueDate.slice(0, 10)}` : "";
}

/** "tool_call · web_search": the action type, plus the tool when there was one. */
export function activityLabel(item: wire.DashActivity): string {
  return item.tool ? `${item.type} · ${item.tool}` : item.type;
}

/**
 * What a list section shows: its rows, the empty sentence, or that the PC could
 * not build it (`null` from the snapshot). Capped at `DASH_LIST_ROWS`.
 */
export type SectionView<T> = { kind: "rows"; rows: T[] } | { kind: "note"; text: string };

export function sectionView<T>(list: readonly T[] | null, empty: string): SectionView<T> {
  if (list === null) return { kind: "note", text: DASH_TEXT.unavailable };
  if (list.length === 0) return { kind: "note", text: empty };
  return { kind: "rows", rows: list.slice(0, DASH_LIST_ROWS) };
}

/** The four health dots, in a fixed order so they never reshuffle between refreshes. */
export function healthDots(health: wire.DashHealth | null): { label: string; level: wire.DashHealth["agentCore"] }[] | undefined {
  if (!health) return undefined;
  return [
    { label: "Agent", level: health.agentCore },
    { label: "Database", level: health.database },
    { label: "OpenRouter", level: health.openRouter },
    { label: "MCP", level: health.mcpServers },
  ];
}
