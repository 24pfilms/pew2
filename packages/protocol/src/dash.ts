/**
 * The OrcaZeroViva dashboard snapshot, as the phone receives it.
 *
 * Mirrors the phone-safe projections in Orca's agent-core
 * (`agent-core/src/phone-bridge/projections.ts`). The daemon parses the PC's
 * reply with these schemas before forwarding it, and zod objects strip unknown
 * keys, so a field added on the PC by mistake still never reaches the phone.
 *
 * Every section is nullable: one part failing on the PC is reported as `null`
 * while the rest of the snapshot still ships.
 */
import { z } from "zod";

const Level = z.enum(["ok", "degraded", "error"]);

export const DashOverview = z.object({
  costTodayUsd: z.number(),
  sessionCount: z.number(),
  factCount: z.number(),
  routineCount: z.number(),
  uptimeMs: z.number(),
});

export const DashHealth = z.object({
  agentCore: Level,
  database: Level,
  openRouter: Level,
  mcpServers: Level,
  uptimeMs: z.number(),
});

/** Action type and tool name only; the PC never sends free text here. */
export const DashActivity = z.object({
  timestamp: z.string(),
  type: z.string(),
  tool: z.string().optional(),
});

export const DashTask = z.object({
  id: z.number(),
  title: z.string(),
  priority: z.string(),
  status: z.string(),
  dueDate: z.string().optional(),
  completedAt: z.string().optional(),
});

export const DashCost = z.object({
  totalUsd: z.number(),
  dailyLimitUsd: z.number().nullable(),
  monthlyLimitUsd: z.number().nullable(),
  alertAtPercent: z.number(),
});

export const DashSession = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
});

export const DashRoutine = z.object({
  id: z.number(),
  name: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string().optional(),
});

export const DashSnapshot = z.object({
  /** Epoch ms on the PC when the snapshot was taken. */
  generatedAt: z.number(),
  overview: DashOverview.nullable(),
  health: DashHealth.nullable(),
  activity: z.array(DashActivity).nullable(),
  tasks: z.array(DashTask).nullable(),
  cost: DashCost.nullable(),
  sessions: z.array(DashSession).nullable(),
  routines: z.array(DashRoutine).nullable(),
});

/**
 * Page views: titles and dates only, mirroring Orca's `phone-bridge/views.ts`.
 * The phone names a page from this fixed list; it never sends a query.
 */
export const DASH_VIEWS = ["projects", "notes", "calendar", "meetings", "workflows", "prompts", "facts"] as const;
export const DashViewName = z.enum(DASH_VIEWS);

export const DashViewItem = z.object({
  id: z.number(),
  title: z.string(),
  detail: z.string().optional(),
  at: z.string().optional(),
});

export const DashView = z.object({
  view: DashViewName,
  generatedAt: z.number(),
  items: z.array(DashViewItem),
});

/**
 * The only two changes the phone may ask for, both on tasks. The title limit
 * matches Orca's `phone-bridge/writes.ts`; the `clientId` lets a retry after
 * flaky mobile data return the first task instead of adding a second.
 */
export const DashTaskOp = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), title: z.string().trim().min(1).max(200), clientId: z.string().min(1).max(64) }),
  z.object({ action: z.literal("complete"), id: z.number().int().positive() }),
]);

export type DashTaskOp = z.output<typeof DashTaskOp>;
export type DashViewName = z.output<typeof DashViewName>;
export type DashViewItem = z.output<typeof DashViewItem>;
export type DashView = z.output<typeof DashView>;
export type DashOverview = z.output<typeof DashOverview>;
export type DashHealth = z.output<typeof DashHealth>;
export type DashActivity = z.output<typeof DashActivity>;
export type DashTask = z.output<typeof DashTask>;
export type DashCost = z.output<typeof DashCost>;
export type DashSession = z.output<typeof DashSession>;
export type DashRoutine = z.output<typeof DashRoutine>;
export type DashSnapshot = z.output<typeof DashSnapshot>;
