/**
 * The dashboard's Tasks section: the pending tasks, a box to add one, and a
 * tick to complete one. These are the only changes the phone can make to
 * the computer, and they work only while the person has turned them on in Orca.
 *
 * Each add carries a `clientId` kept until it succeeds, so a retry after a
 * dropped connection never adds the task twice.
 */
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { wire } from "@pew2/protocol";
import { theme } from "../theme";
import { DASH_TEXT, dueLabel, sectionView, taskOutcome } from "../dashboard";
import { Led } from "./stage/Led";

interface Props {
  tasks: wire.DashTask[] | null;
  changeTask: (task: wire.DashTaskOp) => Promise<wire.Dash>;
  /** Called after a change landed, so the list is asked for again. */
  onChanged: () => void;
}

export function DashboardTasks({ tasks, changeTask, onChanged }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const clientId = useRef<string | undefined>(undefined);
  const view = sectionView(tasks, DASH_TEXT.noTasks);

  const run = async (task: wire.DashTaskOp): Promise<boolean> => {
    setBusy(true);
    const outcome = taskOutcome(await changeTask(task));
    setBusy(false);
    setError(outcome.kind === "error" ? outcome.text : undefined);
    if (outcome.kind === "done") onChanged();
    return outcome.kind === "done";
  };

  const add = async () => {
    const title = draft.trim();
    if (title === "" || busy) return;
    clientId.current ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (await run({ action: "add", title, clientId: clientId.current })) {
      setDraft("");
      clientId.current = undefined;
    }
  };

  return (
    <View style={styles.section}>
      <Led tone="dim" size={10}>Tasks</Led>
      <View style={styles.add}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            clientId.current = undefined;
          }}
          onSubmitEditing={() => void add()}
          placeholder={DASH_TEXT.addTaskPlaceholder}
          placeholderTextColor={theme.color.placeholder}
          accessibilityLabel={DASH_TEXT.addTaskPlaceholder}
          maxLength={200}
          returnKeyType="done"
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Add task" disabled={busy || draft.trim() === ""} onPress={() => void add()} style={({ pressed }) => pressed && styles.pressed}>
          <Ionicons name="add-circle-outline" size={28} color={draft.trim() === "" ? theme.color.textDim : theme.color.glyph} />
        </Pressable>
      </View>
      {error !== undefined && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
      {view.kind === "note" ? (
        <Text style={styles.note}>{view.text}</Text>
      ) : (
        view.rows.map((task) => (
          <View key={task.id} style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Mark done: ${task.title}`}
              disabled={busy}
              onPress={() => void run({ action: "complete", id: task.id })}
              hitSlop={8}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Ionicons name="ellipse-outline" size={22} color={theme.color.glyph} />
            </Pressable>
            <Text style={styles.main} numberOfLines={1}>{task.title}</Text>
            {task.dueDate !== undefined && <Text style={styles.side} numberOfLines={1}>{dueLabel(task.dueDate)}</Text>}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: theme.space(3) },
  add: { flexDirection: "row", alignItems: "center", gap: theme.space(3) },
  input: { flex: 1, color: theme.color.text, fontSize: theme.font.body, paddingVertical: theme.space(2) },
  pressed: { opacity: 0.6 },
  error: { color: theme.color.attention, fontSize: theme.font.small },
  note: { color: theme.color.textDim, fontSize: theme.font.small },
  row: { flexDirection: "row", alignItems: "center", gap: theme.space(3) },
  main: { flex: 1, color: theme.color.text, fontSize: theme.font.body },
  side: { color: theme.color.textDim, fontSize: theme.font.small },
});
