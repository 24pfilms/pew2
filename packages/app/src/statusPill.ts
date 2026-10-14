/**
 * What every status pill in the app says, and in which tone.
 *
 * One treatment across the product ("ink and mark"): a quiet neutral chip,
 * sentence-case label in ordinary ink, and a small solid dot that carries the
 * only colour. It replaced coloured-outline pills with coloured text (a red
 * ring around red "Interrupted" read as an alarm for a goal that only needs a
 * resume). The word always rides with the dot, so colour is never the only
 * signal.
 *
 * The resting state gets no pill at all: a goal that is simply idle shows its
 * last-active time and nothing else, so a pill in the list always means
 * "something to notice".
 *
 * Pure and Expo-free so the mapping is tested; `ui/StatusPill.tsx` draws it.
 */
import type { ChecklistItem } from "./ggReview";
import type { GoalSummary, GoalWorker } from "./ggState";

/** The dot's meaning. The colour for each lives in `ui/StatusPill.tsx`. */
export type PillTone = "live" | "accent" | "attention" | "danger" | "quiet";

export interface Pill {
  label: string;
  tone: PillTone;
  /** A slow breathing dot: something is happening right now. */
  pulse?: boolean;
}

/** A goal in the list or its header. `undefined` for an idle goal: no pill. */
export function goalPill(status: GoalSummary["status"]): Pill | undefined {
  switch (status) {
    case "running":
      return { label: "Running", tone: "live", pulse: true };
    case "briefing":
      return { label: "Briefing", tone: "accent" };
    case "paused":
      return { label: "Paused", tone: "quiet" };
    case "interrupted":
      // Resumable, not broken: amber, never red.
      return { label: "Interrupted", tone: "attention" };
    default:
      return undefined;
  }
}

/** One of GG Goals' workers in a goal's roster. */
export function workerPill(state: GoalWorker["state"]): Pill {
  switch (state) {
    case "starting":
      return { label: "Starting", tone: "accent", pulse: true };
    case "running":
      return { label: "Working", tone: "live", pulse: true };
    case "completed":
      return { label: "Done", tone: "quiet" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "interrupted":
      return { label: "Interrupted", tone: "attention" };
    default:
      return { label: "Closed", tone: "quiet" };
  }
}

/** One project checklist item. */
export function checklistPill(status: ChecklistItem["status"]): Pill {
  switch (status) {
    case "passed":
      return { label: "Passed", tone: "live" };
    case "needs-work":
      return { label: "Needs work", tone: "danger" };
    case "due":
      return { label: "Due", tone: "attention" };
    case "not-run":
      return { label: "Not run", tone: "quiet" };
    default:
      return { label: "N/A", tone: "quiet" };
  }
}
