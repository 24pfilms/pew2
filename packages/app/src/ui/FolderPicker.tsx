/**
 * Choose desktop folders for a goal's context, through the same `workspaces`
 * browse the new-chat sheet uses: suggestions first, tap to descend, "Add"
 * to take the folder being shown. Chosen folders list above with an ×.
 */
import { Dissolve } from "./motion/Dissolve";
import { memo, useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import Reanimated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useReducedMotion } from "./useReducedMotion";
import { Led } from "./stage/Led";
import { StageButton } from "./stage/StageButton";
import { dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { SPRING, withAlpha } from "../motion";
import { theme } from "../theme";
import { haptics } from "./haptics";
import type { WorkspaceBrowse } from "../useDaemon";

interface FolderPickerProps {
  chosen: readonly string[];
  onChange: (folders: string[]) => void;
  browse?: WorkspaceBrowse;
  onBrowse: (path?: string, options?: { files?: boolean }) => void;
  /** Also list files: they can be chosen like folders but never opened. */
  allowFiles?: boolean;
  /** Connected to the computer; a listing that could not be sent is retried when this turns true. */
  online?: boolean;
  /** The caller shows what's chosen itself (the goal screens' chips): skip the list here. */
  hideChosen?: boolean;
  /**
   * With `allowFiles`: the Files tab picks from *this phone* (via the system
   * file picker) instead of browsing the computer's disk, where a file is hard
   * to find from a phone. Called when the user taps it.
   */
  onPickPhoneFiles?: () => void;
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function FolderPickerView({ chosen, onChange, browse, onBrowse: browseTo, online = true, allowFiles = false, hideChosen = false, onPickPhoneFiles }: FolderPickerProps) {
  // Phone files replace browsing the computer for files: the computer listing
  // is then folders only.
  const desktopFiles = allowFiles && !onPickPhoneFiles;
  const onBrowse = useCallback(
    (path?: string) => (desktopFiles ? browseTo(path, { files: true }) : browseTo(path)),
    [browseTo, desktopFiles],
  );
  // Open on the suggestions view, and ask again if that first ask could not be
  // sent (the screen opened before the connection did): `unsent` flips back to
  // false the moment a request does go out, so this runs once per gap.
  useEffect(() => onBrowse(undefined), [onBrowse]);
  const unsent = browse?.unsent === true;
  useEffect(() => {
    if (!unsent || !online) return;
    onBrowse(browse?.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retry on reconnect only
  }, [online]);
  const here = browse?.path;
  // With files allowed, a Folders | Files toggle at the top of the box. Files
  // only exist inside a folder, so Files mode lists them first and keeps the
  // folders below as the way to find more; Folders mode hides files.
  const [mode, setMode] = useState<"folders" | "files">("folders");
  const agent = useAgentColor();
  const reduce = useReducedMotion();
  const modesWidth = useSharedValue(0);
  const slot = useSharedValue(0);
  useEffect(() => {
    const to = mode === "files" ? 1 : 0;
    slot.value = reduce ? to : withSpring(to, SPRING.settle);
  }, [mode, reduce, slot]);
  const thumbStyle = useAnimatedStyle(() => {
    // Two equal tabs inside the box's padding (theme.space(1) a side, a
    // theme.space(1) gap between them).
    const pad = 4;
    const w = Math.max(0, (modesWidth.value - pad * 3) / 2);
    return { width: w, transform: [{ translateX: pad + slot.value * (w + pad) }] };
  });
  const entries = (browse?.entries ?? [])
    .filter((entry) => !allowFiles || mode === "files" || entry.kind !== "file")
    .sort((a, b) => (mode === "files" ? Number(b.kind === "file") - Number(a.kind === "file") : 0));
  const isFile = (path: string) => browse?.entries.some((entry) => entry.path === path && entry.kind === "file") === true;
  const add = (path: string) => {
    if (chosen.includes(path)) return;
    haptics.tap();
    onChange([...chosen, path]);
  };

  return (
    <View style={styles.host}>
      {!hideChosen && chosen.map((path) => (
        <Dissolve key={path}>
        <View style={styles.chosen}>
          <Ionicons name={isFile(path) ? "document-text" : "folder"} size={14} color={theme.color.accent} />
          <Text style={styles.chosenText} numberOfLines={1}>
            {path}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${lastSegment(path)}`}
            hitSlop={12}
            onPress={() => onChange(chosen.filter((entry) => entry !== path))}
          >
            <Ionicons name="close" size={14} color={theme.color.textDim} />
          </Pressable>
        </View>
        </Dissolve>
      ))}
      <View style={styles.browser}>
        {allowFiles && (
          <View
            style={styles.modes}
            accessibilityRole="tablist"
            onLayout={(e) => {
              modesWidth.value = e.nativeEvent.layout.width;
            }}
          >
            {/* One highlight that slides between the two tabs, on a spring,
                instead of the selected one simply switching colour. */}
            <Reanimated.View style={[styles.modeThumb, { borderColor: agent, backgroundColor: withAlpha(agent, 0.1) }, thumbStyle]} pointerEvents="none" />
            {(["folders", "files"] as const).map((m) => (
              <Pressable
                key={m}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === m }}
                onPress={() => {
                  if (m === mode) return;
                  haptics.select();
                  setMode(m);
                }}
                style={styles.mode}
              >
                <Ionicons name={m === "files" ? "document-text-outline" : "folder-outline"} size={13} color={mode === m ? agent : theme.color.textDim} />
                <Led tone={mode === m ? "agent" : "dim"}>{m === "files" ? "Files" : "Folders"}</Led>
              </Pressable>
            ))}
          </View>
        )}
        {mode === "files" && onPickPhoneFiles ? (
          <Reanimated.View key="phone" style={styles.phone} entering={reduce ? undefined : FadeIn.duration(200)}>
            <Ionicons name="phone-portrait-outline" size={26} color={agent} />
            <Led tone="dim">From this phone</Led>
            <StageButton
              kind="secondary"
              compact
              style={styles.phoneBtn}
              label="Choose files"
              icon={<Ionicons name="document-attach-outline" size={15} color={theme.color.text} />}
              onPress={onPickPhoneFiles}
            />
          </Reanimated.View>
        ) : (
        <>
        <View style={styles.bar}>
          {browse?.parent !== undefined ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Up one folder" hitSlop={10} onPress={() => onBrowse(browse.parent)}>
              <Ionicons name="arrow-up" size={16} color={theme.color.textDim} />
            </Pressable>
          ) : null}
          <View style={styles.where}>
            <Led tone="dim">{here ? lastSegment(here) : mode === "files" ? "Open a folder for files" : "Suggested"}</Led>
          </View>
          {here && !chosen.includes(here) && mode === "folders" ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Add this folder" onPress={() => add(here)} hitSlop={10}>
              <Led>+ Add folder</Led>
            </Pressable>
          ) : null}
        </View>
        <ScrollView style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {/* Keyed by mode: switching tabs dissolves the old list out and the
              new one in, rather than swapping rows in place. */}
          <Reanimated.View key={mode} entering={reduce ? undefined : FadeIn.duration(200)} exiting={reduce ? undefined : FadeOut.duration(120)}>
          {entries.map((entry) => (
            <View key={entry.path} style={[styles.entry, entries[0] !== entry && styles.entryRule]}>
              <Pressable
                style={styles.entryMain}
                accessibilityRole="button"
                accessibilityLabel={entry.kind === "file" ? `Add ${entry.name}` : `Open ${entry.name}`}
                // A file is never browsed into: tapping it chooses it instead.
                onPress={() => (entry.kind === "file" ? add(entry.path) : onBrowse(entry.path))}
              >
                <Ionicons
                  name={entry.kind === "file" ? "document-text-outline" : entry.repo ? "git-branch-outline" : "folder-outline"}
                  size={15}
                  color={theme.color.textDim}
                />
                <Text style={styles.entryName} numberOfLines={1}>
                  {entry.name}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${entry.name}`}
                hitSlop={10}
                disabled={chosen.includes(entry.path)}
                onPress={() => add(entry.path)}
              >
                <Ionicons
                  name={chosen.includes(entry.path) ? "checkmark-circle" : "add-circle-outline"}
                  size={20}
                  color={chosen.includes(entry.path) ? agent : theme.color.textDim}
                />
              </Pressable>
            </View>
          ))}
          </Reanimated.View>
          {entries.length === 0 && (
            <Led tone="dim" style={styles.empty}>
              {browse?.loading
                ? "Looking…"
                : browse?.unsent || !online
                  ? "Waiting for your computer…"
                  : browse?.refused
                    ? "Can't open that folder"
                    : "Nothing here"}
            </Led>
          )}
        </ScrollView>
        </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { gap: theme.space(2) },
  chosen: { flexDirection: "row", alignItems: "center", gap: theme.space(2), paddingHorizontal: theme.space(1) },
  chosenText: { flex: 1, color: theme.color.text, fontSize: theme.font.small },
  // Stage: a dashed box on the strip colour, like the other pickers' panels.
  browser: {
    ...dashedOutline,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.stage.strip,
    overflow: "hidden",
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  where: { flex: 1, minWidth: 0 },
  modes: {
    flexDirection: "row",
    gap: theme.space(1),
    padding: theme.space(1),
  },
  mode: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(1.5),
    height: 34,
    borderRadius: theme.radius.sm,
  },
  modeThumb: { position: "absolute", top: 4, bottom: 4, left: 0, borderRadius: theme.radius.md, borderWidth: 1 },
  list: { maxHeight: 200 },
  entry: { flexDirection: "row", alignItems: "center", paddingHorizontal: theme.space(3), minHeight: theme.size.touch },
  entryRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.stage.dash },
  entryMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  entryName: { flex: 1, color: theme.color.text, fontSize: theme.font.body },
  empty: { padding: theme.space(3) },
  phone: { alignItems: "center", gap: theme.space(2), paddingVertical: theme.space(6), paddingHorizontal: theme.space(4) },
  phoneBtn: { alignSelf: "stretch", marginTop: theme.space(2) },
});

export const FolderPicker = memo(FolderPickerView);
