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

export type DashOverview = z.output<typeof DashOverview>;
export type DashHealth = z.output<typeof DashHealth>;
export type DashActivity = z.output<typeof DashActivity>;
export type DashTask = z.output<typeof DashTask>;
export type DashCost = z.output<typeof DashCost>;
export type DashSession = z.output<typeof DashSession>;
export type DashRoutine = z.output<typeof DashRoutine>;
export type DashSnapshot = z.output<typeof DashSnapshot>;
