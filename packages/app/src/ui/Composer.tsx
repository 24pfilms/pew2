/** Beam-reference composer: utility row, stable text field, settings + send.
 * Draft ownership stays in ComposerDock; native layout owns text growth.
 */
import { forwardRef, memo, useImperativeHandle, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import Reanimated, { useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { DotGlyph } from "./stage/DotGlyph";
import { DotGrid } from "./stage/DotGrid";
import { Led } from "./stage/Led";
import { useAgentColor } from "./stage/agentColor";
import { withAlpha } from "../motion";
import { Pixel } from "./stage/Pixel";
import { StageChip } from "./StageChip";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { sounds } from "./sounds";
import { CommandToken } from "./CommandToken";
import { splitCommand } from "../slashCommands";
import { AttachmentChips } from "./AttachmentChips";
import type { PendingAttachment } from "../attachments";
import type { Dictation } from "./useDictation";
import { pressStops } from "../composerState";

const EMPTY_ATTACHMENTS: readonly PendingAttachment[] = [];
const EMPTY_SELECTORS: readonly ComposerSelector[] = [];
export interface ComposerAnchor { x: number; y: number }
export interface ComposerSelector {
  id: string;
  value: string;
  label: string;
  onPress: (anchor: ComposerAnchor) => void;
  /**
   * A switch rather than a picker: pressing flips it, there is no menu and no
   * chevron, and `on` lights it in accent so its state reads at a glance.
   */
  toggle?: { on: boolean };
}
export interface ComposerHandle { focus(): void }
interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  busy?: boolean;
  onStop?: () => void;
  placeholder?: string;
  editable?: boolean;
  attachments?: readonly PendingAttachment[];
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  dictation?: Dictation;
  selectors?: readonly ComposerSelector[];
  /**
   * Uncommitted files in the project, as a number after the pills (after
   * Autopilot for GG Coder): the one place the app shows it. Absent when the
   * folder isn't a Git repo or the daemon hasn't said; 0 shows nothing.
   */
  changes?: { count: number; accessibilityLabel: string; onPress?: () => void };
}

function Selector({ value, label, onPress, toggle }: ComposerSelector) {
  const target = useRef<View>(null);
  if (toggle) {
    return (
      <View style={styles.selectorTarget}>
        <StageChip
          label={value}
          lit={toggle.on}
          feel="select"
          accessibilityRole="switch"
          accessibilityLabel={label}
          accessibilityState={{ checked: toggle.on }}
          leading={toggle.on ? <Pixel kind="live" /> : null}
          onPress={() => onPress({ x: 0, y: 0 })}
        />
      </View>
    );
  }
  return (
    <View ref={target} collapsable={false} style={styles.selectorTarget}>
      <StageChip
        label={value}
        feel="none"
        accessibilityLabel={label}
        accessibilityHint="Opens available options"
        trailing={<DotGlyph name="chevron-down" size={10} color={theme.composer.ink} />}
        onPress={() => target.current?.measureInWindow((x, y) => { haptics.tap(); onPress({ x, y }); })}
      />
    </View>
  );
}

function ComposerView({
  value, onChangeText, onSend, busy = false, onStop,
  placeholder = "Build anything...", editable = true,
  attachments = EMPTY_ATTACHMENTS, onAttach, onRemoveAttachment,
  dictation, selectors = EMPTY_SELECTORS, changes,
}: ComposerProps, ref: React.Ref<ComposerHandle>) {
  const input = useRef<TextInput>(null);
  const agent = useAgentColor();
  // Lit while the keyboard is up, from the keyboard's own progress on the UI
  // thread. NEVER from React state: re-rendering this card while its field
  // takes focus (a new border colour, a shadow) makes iOS drop the focus, so
  // the keyboard rose and fell and the input took several taps to open. That
  // was true of onFocus state and of a `typing` prop alike. The glow is a
  // separate layer whose opacity animates; the card itself never re-renders.
  const keyboard = useReanimatedKeyboardAnimation();
  const lit = useAnimatedStyle(() => ({ opacity: keyboard.progress.value }));
  const unlit = useAnimatedStyle(() => ({ opacity: 1 - keyboard.progress.value }));
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const [atCeiling, setAtCeiling] = useState(false);
  const { fontScale, height: viewportHeight } = useWindowDimensions();
  const minTextHeight = Math.max(theme.space(16), theme.line.body * fontScale);
  const maxTextHeight = Math.max(minTextHeight, Math.min(8 * theme.line.body * fontScale, viewportHeight * 0.25));
  const split = splitCommand(value);
  const canSend = editable && !dictation?.listening && (value.trim().length > 0 || attachments.length > 0);
  // A turn running is no reason to stop sending: with words in the box the
  // button sends (the daemon queues it for the agent's next step); empty, it
  // stops the turn.
  const stopping = pressStops({ busy, canSend });
  const showMic = !busy && (!canSend || !!dictation?.listening);
  const sendDisabled = stopping ? !onStop : showMic ? !dictation?.available || !editable : !canSend;
  const actionLabel = stopping ? "Stop generating" : showMic ? dictation?.listening ? "Stop dictating" : dictation?.available ? "Dictate a message" : "Voice input unavailable" : "Send message";
  return (
    <View style={styles.stack}>
      {attachments.length > 0 && <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />}
      {/* A Stage panel: the dot texture on the strip colour, ruled in the
          agent's colour while you write (dim otherwise), with an LED prompt. */}
      <View style={styles.card}>
        <View style={[StyleSheet.absoluteFill, styles.cardClip]} pointerEvents="none">
          <DotGrid fine />
        </View>
        {/* The lit edge: drawn over the card's own border, faded in with the
            keyboard. */}
        <Reanimated.View
          pointerEvents="none"
          style={[styles.glow, { borderColor: withAlpha(agent, 0.75) }, lit]}
        />
        <Pressable
          style={StyleSheet.absoluteFill}
          accessible={false} importantForAccessibility="no" disabled={!editable}
          onPress={() => input.current?.focus()}
        />
          {split && (
            <Pressable
              style={({ pressed }) => [styles.commandTarget, pressed && styles.pressed]}
              accessibilityRole="button" accessibilityLabel={`Remove ${split.command}`}
              onPress={() => { onChangeText(split.rest.replace(/^ /, "")); input.current?.focus(); }}
            >
              <View style={styles.tag}>
                <CommandToken text={split.command} size={theme.font.small} lineHeight={18} />
                <Ionicons name="close" size={13} color={theme.composer.ink} />
              </View>
            </Pressable>
          )}
        {/* Do not constrain this wrapper's height: UIKit otherwise reports the
            clipped viewport as content height, hiding new lines and the caret. */}
        <View style={styles.textArea}>
          <Reanimated.View style={[styles.prompt, lit]} pointerEvents="none">
            <Led color={agent}>{">"}</Led>
          </Reanimated.View>
          <View style={styles.prompt} pointerEvents="none">
            <Reanimated.View style={unlit}>
              <Led tone="dim">{">"}</Led>
            </Reanimated.View>
          </View>
          <TextInput
            ref={input} style={[styles.input, { minHeight: minTextHeight, maxHeight: maxTextHeight }]}
            value={split ? split.rest.replace(/^ /, "") : value}
            onChangeText={(text) => onChangeText(split ? `${split.command} ${text}` : text)}
            onContentSizeChange={({ nativeEvent }) => {
              const capped = nativeEvent.contentSize.height >= maxTextHeight;
              if (capped !== atCeiling) setAtCeiling(capped);
            }}
            placeholder={placeholder} placeholderTextColor={theme.composer.placeholder}
            multiline editable={editable} accessibilityLabel="Message"
            submitBehavior="newline" scrollEnabled={atCeiling}
          />
        </View>
        <View style={styles.bottomRow} pointerEvents="box-none">
          <Pressable
            style={({ pressed }) => [styles.iconTarget, pressed && styles.pressed]}
            accessibilityRole="button" accessibilityLabel="Add attachment"
            accessibilityState={{ disabled: !onAttach || !editable }} disabled={!onAttach || !editable}
            onPress={() => { haptics.tap(); onAttach?.(); }}
          >
            <DotGlyph name="plus" size={18} color={theme.composer.ink} />
          </Pressable>
          <View style={styles.selectors} pointerEvents="box-none">
            {selectors.map((selector) => <Selector key={selector.id} {...selector} />)}
            {changes && changes.count > 0 ? (
              // Same dashed chip as Model and Autopilot beside it.
              <View style={styles.fixedTarget}>
                <StageChip
                  label={String(changes.count)}
                  compact
                  leading={<Ionicons name="git-compare-outline" size={12} color={theme.color.textDim} />}
                  accessibilityLabel={changes.accessibilityLabel}
                  onPress={changes.onPress}
                />
              </View>
            ) : null}
          </View>
          <Pressable
            style={({ pressed }) => [styles.iconTarget, pressed && styles.pressed]}
            accessibilityRole="button" accessibilityLabel={actionLabel}
            accessibilityState={{ disabled: sendDisabled }} disabled={sendDisabled}
            onPress={() => {
              if (stopping) { haptics.warned(); onStop?.(); }
              else if (showMic) dictation?.toggle();
              else { haptics.sent(); sounds.play("send"); onSend(); }
            }}
          >
            <View style={[styles.sendPill, ((!showMic && !sendDisabled) || dictation?.listening) && { backgroundColor: agent, shadowColor: agent, shadowOpacity: 0.6 }]}>
              {/* Send is the dot-matrix arrow; stop and the mic keep their glyphs
                  (no pixel version reads as well at this size). */}
              {!stopping && !showMic ? (
                <DotGlyph name="up" size={16} color={!sendDisabled ? theme.color.bg : theme.composer.ink} />
              ) : (
                <Ionicons name={stopping ? "square" : dictation?.listening ? "mic" : "mic-outline"} size={stopping ? 13 : 18} color={dictation?.listening ? theme.color.bg : theme.composer.ink} />
              )}
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space(2) },
  card: {
    backgroundColor: theme.stage.strip,
    borderRadius: theme.composer.radius,
    borderWidth: 1,
    borderColor: theme.composer.border,
    padding: theme.space(1),
  },
  cardClip: { borderRadius: theme.composer.radius, overflow: "hidden" },
  glow: {
    position: "absolute",
    top: -1,
    left: -1,
    right: -1,
    bottom: -1,
    borderRadius: theme.composer.radius,
    borderWidth: 1,
    // No shadow: a shadow on a layer whose opacity animates is re-rendered
    // offscreen every frame, and this one animates with the keyboard.
  },
  prompt: { position: "absolute", left: 0, top: 3 },
  iconTarget: { width: theme.size.touch, height: theme.size.touch, alignItems: "center", justifyContent: "center" },
  sendPill: { width: 32, height: 32, borderRadius: theme.radius.pill, borderWidth: 1, borderStyle: "dashed", borderColor: theme.stage.dash, alignItems: "center", justifyContent: "center", shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  pressed: { opacity: 0.65 },
  // Room on the left for the LED prompt; the text starts after it.
  textArea: { marginHorizontal: theme.space(2), marginTop: theme.space(2), paddingLeft: theme.space(4) },
  input: { padding: 0, color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body, textAlignVertical: "top" },
  bottomRow: { flexDirection: "row", alignItems: "center", gap: theme.space(1) },
  selectors: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
  // Pills sit 4pt apart (2pt padding a side): three of them (Model, Autopilot,
  // the changes count) fit beside + and send without truncating.
  selectorTarget: { minWidth: theme.size.touch, minHeight: theme.size.touch, flexShrink: 1, justifyContent: "center", paddingHorizontal: theme.space(0.5) },
  fixedTarget: { minHeight: theme.size.touch, flexShrink: 0, justifyContent: "center", paddingHorizontal: theme.space(0.5) },
  commandTarget: { minHeight: theme.size.touch, flexShrink: 1, justifyContent: "center" },
  tag: { flexDirection: "row", alignItems: "center", gap: theme.space(1), paddingHorizontal: theme.space(2), paddingVertical: theme.space(1.5), borderRadius: theme.radius.pill, backgroundColor: theme.composer.chip },
});
export const Composer = memo(forwardRef<ComposerHandle, ComposerProps>(ComposerView));
