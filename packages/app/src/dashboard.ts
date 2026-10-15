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
  noItems: "Nothing here.",
  pagesOldDaemon: "Update pew2 on your computer to open pages.",
  tasksOldDaemon: "Update pew2 on your computer to change tasks.",
  addTaskPlaceholder: "Add a task",
} as const;

/** The pages the phone can open, in the order they are listed. Names match the wire enum. */
export const DASH_PAGES: readonly { view: wire.DashViewName; label: string }[] = [
  { view: "projects", label: "Projects" },
  { view: "notes", label: "Notes" },
  { view: "calendar", label: "Calendar" },
  { view: "meetings", label: "Meetings" },
  { view: "workflows", label: "Workflows" },
  { view: "prompts", label: "Prompts" },
  { view: "facts", label: "Memory facts" },
];

export type TaskOutcome = { kind: "done"; task: wire.DashTask } | { kind: "error"; text: string };

/** What a task change came back with. An older daemon drops `task` and answers a snapshot, which changed nothing. */
export function taskOutcome(reply: wire.Dash): TaskOutcome {
  if (reply.task) return { kind: "done", task: reply.task };
  if (reply.snapshot) return { kind: "error", text: DASH_TEXT.tasksOldDaemon };
  return { kind: "error", text: reply.error ?? DASH_TEXT.noReply };
}

export type PageOutcome = { kind: "items"; items: wire.DashViewItem[]; generatedAt: number } | { kind: "error"; text: string };

/**
 * What a page request came back with. An older daemon ignores `view` and
 * answers with the summary, so a reply that has a snapshot but no `view` is
 * that, not a page. A reply for some other page is refused, never shown.
 */
export function pageOutcome(reply: wire.Dash, view: wire.DashViewName): PageOutcome {
  if (reply.view === view && reply.items) return { kind: "items", items: reply.items, generatedAt: reply.generatedAt ?? 0 };
  if (reply.snapshot && reply.view === undefined) return { kind: "error", text: DASH_TEXT.pagesOldDaemon };
  return { kind: "error", text: reply.error ?? DASH_TEXT.noReply };
}

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

/** A date with no time ("2026-10-20", a due date) reads as written; a timestamp reads as "3h ago". */
export function whenLabel(at: string, now: number): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : relativeTime(at, now);
}
