/**
 * The slash command picker: Stage's "Palette" sheet.
 *
 * Commands come from the agent and vary by project — `.claude/commands`,
 * `.gg/commands` and its own built-ins — so this never assumes a fixed set.
 * `slashCommands.ts` decides which are offered here at all.
 *
 * A filter with an LED "/" prompt, then one command name per row in LED type,
 * filtered live. Names only: the point is to find one quickly.
 */
import { memo, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { Sheet, SHEET_ROW_HEIGHT, SHEET_VISIBLE_ROWS } from "./Sheet";
import { Led } from "./stage/Led";
import { DashedRule, dashedOutline } from "./stage/DashedRule";
import { Dissolve } from "./motion/Dissolve";
import type { SlashCommand } from "../slashCommands";

interface CommandSheetProps {
  visible: boolean;
  commands: SlashCommand[];
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

const ROW_HEIGHT = SHEET_ROW_HEIGHT - theme.space(4);

function CommandSheetView({ visible, commands, onSelect, onClose }: CommandSheetProps) {
  const [query, setQuery] = useState("");
  // A fresh filter every open; a stale one would hide commands for no reason.
  useEffect(() => {
    if (visible) setQuery("");
  }, [visible]);

  const needle = query.trim().replace(/^\//, "").toLowerCase();
  const shown = needle ? commands.filter((c) => c.name.toLowerCase().includes(needle)) : commands;
  const listHeight = Math.max(1, Math.min(shown.length, SHEET_VISIBLE_ROWS)) * ROW_HEIGHT;
  const scrolls = shown.length > SHEET_VISIBLE_ROWS;

  return (
    <Sheet visible={visible} label="Commands" title="Slash commands" onClose={onClose} dismissLabel="Close commands">
      <View style={styles.filter}>
        <Led>/</Led>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Filter"
          placeholderTextColor={theme.color.textDim}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Filter commands"
        />
      </View>
      <ScrollView
        style={{ height: listHeight }}
        showsVerticalScrollIndicator={scrolls}
        bounces={scrolls}
        keyboardShouldPersistTaps="handled"
      >
        {shown.length === 0 && (
          <View style={styles.row}>
            <Led tone="dim">No match</Led>
          </View>
        )}
        {shown.map((command, index) => (
          <Dissolve key={command.name} kind="row" delay={Math.min(index, 8) * 50}>
            {index > 0 && <DashedRule />}
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Run ${command.name}`}
              onPress={() => {
                haptics.select();
                onSelect(command);
              }}
            >
              <Led>/{command.name}</Led>
            </Pressable>
          </Dissolve>
        ))}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  filter: {
    ...dashedOutline,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    minHeight: theme.size.touch,
    marginBottom: theme.space(2),
  },
  input: { flex: 1, color: theme.color.text, fontSize: theme.font.body, paddingVertical: theme.space(2) },
  row: { height: ROW_HEIGHT, justifyContent: "center" },
  pressed: { opacity: 0.6 },
});

export const CommandSheet = memo(CommandSheetView);
