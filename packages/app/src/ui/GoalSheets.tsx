/**
 * The topmost sheets: New goal and goal settings, then everything the agent
 * is blocked on (approval, ask_user, plan review) and the checklist.
 */
import { NewGoalSheet } from "./NewGoalSheet";
import { GoalSettingsSheet } from "./GoalSettingsSheet";
import { ApprovalSheet } from "./ApprovalSheet";
import { AskUserSheet } from "./AskUserSheet";
import { ChecklistSheet, PlanReviewSheet } from "./GgReview";
import type { useDaemon } from "../useDaemon";
import type { useGoalControls } from "../useGoalControls";

export function GoalSheets({
  daemon,
  goals,
  newGoalOpen,
  newGoalPrefill,
  answerPermission,
  send,
}: {
  daemon: ReturnType<typeof useDaemon>;
  goals: ReturnType<typeof useGoalControls>;
  newGoalOpen: boolean;
  newGoalPrefill: string | undefined;
  answerPermission: (requestId: string, optionId: string, deny: boolean) => void;
  send: (text: string) => boolean;
}) {
  const {
    gg,
    createGoal,
    goalAction,
    browseWorkspaces,
    askHere,
    goalState,
    goalHere,
    planHere,
    stripsHere,
    checklistOpen,
    setChecklistOpen,
    checklistHere,
    decidePlan,
    answerAsk,
    closeNewGoal,
    goalCreated,
    goalSettingsOpen,
    closeGoalSettings,
  } = goals;
  return (
    <>
      {/* Last of every overlay on purpose. All the sheets share one zIndex, so
          paint order is sibling order — and an approval the agent is blocked on
          must sit above anything the user happened to have open. */}
      <NewGoalSheet
        visible={newGoalOpen}
        onClose={closeNewGoal}
        onCreate={createGoal}
        results={gg.goalResults}
        onCreated={goalCreated}
        browse={daemon.browse}
        onBrowse={browseWorkspaces}
        prefill={newGoalPrefill}
        online={daemon.status === "online"}
      />
      <GoalSettingsSheet
        visible={goalSettingsOpen}
        goal={goalHere}
        state={goalState}
        onAction={goalAction}
        results={gg.goalResults}
        modelOption={daemon.providerConfigs.ggcoder?.find((option) => option.id === "model")}
        onClose={closeGoalSettings}
        browse={daemon.browse}
        onBrowse={browseWorkspaces}
        online={daemon.status === "online"}
      />

      <ApprovalSheet permission={daemon.permission} onAnswer={answerPermission} />
      {/* Same rule as the approval: a question the agent is blocked on sits
          above whatever else is open. Never raised by a replay batch. */}
      <AskUserSheet ask={askHere} onAnswer={answerAsk} />
      <PlanReviewSheet plan={stripsHere.plan ? planHere?.pending ?? undefined : undefined} busy={daemon.busy} onDecide={decidePlan} />
      <ChecklistSheet
        visible={checklistOpen}
        items={checklistHere?.items}
        error={checklistHere?.error}
        busy={daemon.busy}
        onClose={() => setChecklistOpen(false)}
        onRun={(prompt) => {
          setChecklistOpen(false);
          send(prompt);
        }}
      />
    </>
  );
}
