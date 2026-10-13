/**
 * Model / thinking-level selector: Stage's "Dial" sheet.
 *
 * Everything here comes from the agent's own `configOptions`, so connecting a
 * new app brings its models and reasoning levels with it and pew2 never carries
 * a hardcoded model list that would go stale.
 *
 * Models are a compact list capped at ~5 rows that scrolls inside the sheet
 * (agents like GG Coder carry dozens), with a filter field once it is long. A thinking level, when the agent
 * advertises one, is a dial: an arc of dots lit up to the chosen level with Pew
 * in the middle, whose mood follows the level. An agent's plain list (opened
 * for "mode") is a simple Stage list.
 *
 * A `Sheet`, like every other picker, so it gets the Terminal header.
 * `anchorX`/`anchorY` are kept for App.tsx's call but no longer position it.
 */
import { memo, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Reanimated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import type { ConfigOption } from "../useDaemon";
import { useReducedMotion } from "./useReducedMotion";
import { Sheet } from "./Sheet";
import { Led } from "./stage/Led";
import { Dissolve } from "./motion/Dissolve";
import { DashedRule, dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { Pew } from "../pew/Pew";
import type { PewMood } from "../pew/engine";
import { DUR } from "../motion";
import { summarise, valueName } from "./configSlots";

// Slot assignment lives in a react-native-free module so it can be unit tested.
export { summarise, valueName } from "./configSlots";

interface ConfigPickerProps {
  visible: boolean;
  onClose: () => void;
  options: ConfigOption[];
  onSelect: (configId: string, value: string | boolean) => void;
  /** Kept for callers; the sheet rises from the bottom edge. */
  anchorX?: number;
  /** Kept for callers; the sheet rises from the bottom edge. */
  anchorY?: number;
}

/** Model list: fixed row height so the list can open scrolled to the pick. */
const ROW = 56;
const LIST_MAX = ROW * 5 + 20;
const FILTER_AFTER = 8;

/** Dial geometry: a 240° arc opening downward. */
const DIAL = 200;
const DIAL_RADIUS = 80;
const DOT = 12;
const ARC_START = 150; // degrees, clockwise from +x (screen coords)
const ARC_SPAN = 240;

/** Pew's mood for a position along the dial, 0..1. */
function levelMood(fraction: number): PewMood {
  if (fraction <= 0) return "sleepy";
  if (fraction < 0.5) return "idle";
  if (fraction < 0.85) return "thinking";
  return "working";
}

function ConfigPickerView({ visible, onClose, options, onSelect }: ConfigPickerProps) {
  const agent = useAgentColor();
  const { model, mode, level } = summarise(options);
  const modeOnly = !model && !level && mode;
  const list = modeOnly ? mode : undefined;
  const chips = list ? undefined : model;
  const levelIndex = level?.options?.findIndex((v) => v.value === level.currentValue) ?? -1;
  const levelCount = level?.options?.length ?? 0;
  const fraction = levelCount > 1 ? Math.max(0, levelIndex) / (levelCount - 1) : 0;

  const title = list ? (list.name || "Mode") : (valueName(model) ?? "Model");
  const sub = list ? undefined : [model?.name, level ? `${valueName(level) ?? ""} thinking` : undefined].filter(Boolean).join(" · ");

  const pick = (option: ConfigOption, value: string) => {
    haptics.select();
    onSelect(option.id, value);
    onClose();
  };

  const step = (index: number) => {
    const value = level?.options?.[index];
    if (!level || !value || index === levelIndex) return;
    haptics.detent();
    onSelect(level.id, value.value);
  };

  return (
    <Sheet
      visible={visible}
      label={list ? "Mode" : "Model"}
      title={title}
      onClose={onClose}
      dismissLabel="Close picker"
      pewMood={level ? levelMood(fraction) : undefined}
      // Switching model mid-sentence is not leaving the draft.
      keepKeyboard
    >
      <View style={styles.body}>
        {!!sub && <Text style={styles.sub} numberOfLines={1}>{sub}</Text>}

        {!chips && !list && <Text style={styles.sub}>This agent offers no model options.</Text>}

        {chips && (
          <ModelList option={chips} color={agent} visible={visible} onPick={(value) => pick(chips, value)} />
        )}

        {level && levelCount > 0 && (
          <Dial
            names={level.options?.map((v) => v.name) ?? []}
            index={Math.max(0, levelIndex)}
            fraction={fraction}
            color={agent}
            paused={!visible}
            onStep={step}
          />
        )}

        {list && (
          <View>
            {list.options?.map((value, i) => {
              const selected = value.value === list.currentValue;
              return (
                <View key={value.value}>
                  {i > 0 && <DashedRule />}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={value.name}
                    accessibilityState={{ selected }}
                    onPress={() => pick(list, value.value)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <Text style={styles.rowText} numberOfLines={1}>{value.name}</Text>
                    {selected && <Ionicons name="checkmark" size={18} color={agent} />}
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </Sheet>
  );
}

interface ModelListProps {
  option: ConfigOption;
  color: string;
  visible: boolean;
  onPick: (value: string) => void;
}

function ModelList({ option, color, visible, onPick }: ModelListProps) {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);
  const all = option.options ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? all.filter((v) => `${v.name} ${v.value} ${v.description ?? ""}`.toLowerCase().includes(needle))
    : all;
  const selectedIndex = all.findIndex((v) => v.value === option.currentValue);
  // Opens with the current model in view (second row, so there is context above).
  const initialY = Math.max(0, (selectedIndex - 1) * ROW);

  return (
    <View style={styles.modelWrap}>
      {all.length > FILTER_AFTER && (
        <View style={styles.filter}>
          <Led tone="agent" color={color}>/</Led>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Filter models"
            placeholderTextColor={theme.color.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel="Filter models"
            style={styles.filterInput}
          />
        </View>
      )}
      <ScrollView
        style={styles.modelList}
        contentOffset={{ x: 0, y: needle ? 0 : initialY }}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {shown.length === 0 && <Text style={styles.sub}>No model matches.</Text>}
        {shown.map((value, i) => {
          const selected = value.value === option.currentValue;
          const row = (
            <View>
              {i > 0 && <DashedRule />}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={value.name}
                accessibilityState={{ selected }}
                onPress={() => onPick(value.value)}
                style={({ pressed }) => [styles.modelRow, pressed && styles.pressed]}
              >
                <View style={[styles.bar, selected && { backgroundColor: color }]} />
                <View style={styles.modelText}>
                  <Text style={[styles.modelName, selected && { color }]} numberOfLines={1}>{value.name}</Text>
                  {!!value.description && (
                    <Text style={styles.modelDetail} numberOfLines={1}>{value.description}</Text>
                  )}
                </View>
                {selected && <Ionicons name="checkmark" size={18} color={color} />}
              </Pressable>
            </View>
          );
          return reduceMotion || i >= 6 ? (
            <View key={value.value}>{row}</View>
          ) : (
            <Dissolve key={value.value} kind="row" delay={i * 40}>{row}</Dissolve>
          );
        })}
      </ScrollView>
    </View>
  );
}

interface DialProps {
  names: string[];
  index: number;
  fraction: number;
  color: string;
  paused: boolean;
  onStep: (index: number) => void;
}

function Dial({ names, index, fraction, color, paused, onStep }: DialProps) {
  const count = names.length;
  const centre = DIAL / 2;
  const angleAt = (i: number) =>
    ((ARC_START + (count > 1 ? (ARC_SPAN * i) / (count - 1) : ARC_SPAN / 2)) * Math.PI) / 180;
  const end = (i: number) => ({
    left: centre + DIAL_RADIUS * Math.cos(angleAt(i)),
    top: centre + DIAL_RADIUS * Math.sin(angleAt(i)),
  });
  const first = end(0);
  const last = end(count - 1);

  return (
    <View style={styles.dialWrap}>
      <View style={styles.dial}>
        {names.map((name, i) => {
          const at = end(i);
          return (
            <DialDot
              key={name}
              lit={i <= index}
              order={i}
              color={color}
              label={name}
              style={{ left: at.left - DOT, top: at.top - DOT }}
              onPress={() => onStep(i)}
            />
          );
        })}
        <View style={styles.dialPew} pointerEvents="box-none">
          <Pew size={112} mood={levelMood(fraction)} color={color} paused={paused} accessibilityLabel="Pew" />
        </View>
        <StepButton icon="remove" label="Less thinking" disabled={index <= 0} at={{ left: first.left - 22, top: first.top + 14 }} onPress={() => onStep(index - 1)} />
        <StepButton icon="add" label="More thinking" disabled={index >= count - 1} at={{ left: last.left - 22, top: last.top + 14 }} onPress={() => onStep(index + 1)} />
      </View>
      <Led size={theme.stage.ledSize + 4}>{names[index] ?? ""}</Led>
    </View>
  );
}

interface DialDotProps {
  lit: boolean;
  order: number;
  color: string;
  label: string;
  style: { left: number; top: number };
  onPress: () => void;
}

function DialDot({ lit, order, color, label, style, onPress }: DialDotProps) {
  const reduceMotion = useReducedMotion();
  const on = useSharedValue(lit ? 1 : 0);
  useEffect(() => {
    on.value = reduceMotion
      ? lit ? 1 : 0
      : withDelay(order * 30, withTiming(lit ? 1 : 0, { duration: DUR.row }));
  }, [lit, order, reduceMotion, on]);
  const animated = useAnimatedStyle(() => ({
    opacity: 0.25 + on.value * 0.75,
    transform: [{ scale: 0.8 + on.value * 0.3 }],
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: lit }}
      onPress={onPress}
      style={[styles.dotHit, style]}
    >
      <Reanimated.View
        style={[styles.dot, { backgroundColor: color, shadowColor: color }, animated]}
      />
    </Pressable>
  );
}

function StepButton({ icon, label, disabled, at, onPress }: {
  icon: "add" | "remove";
  label: string;
  disabled: boolean;
  at: { left: number; top: number };
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.stepButton, at, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={18} color={theme.color.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { gap: theme.space(4), paddingBottom: theme.space(2) },
  sub: { color: theme.color.textDim, fontSize: theme.font.small },
  modelWrap: { gap: theme.space(2) },
  filter: {
    ...dashedOutline,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    height: 40,
  },
  filterInput: { flex: 1, color: theme.color.text, fontSize: theme.font.small, paddingVertical: 0 },
  modelList: { maxHeight: LIST_MAX, flexGrow: 0 },
  modelRow: { flexDirection: "row", alignItems: "center", height: ROW - 1, gap: theme.space(3) },
  bar: { width: 3, alignSelf: "stretch", marginVertical: theme.space(2), borderRadius: 2 },
  modelText: { flex: 1, minWidth: 0 },
  modelName: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
  modelDetail: { color: theme.color.textDim, fontSize: theme.font.small },
  pressed: { opacity: 0.7 },
  dialWrap: { alignItems: "center", gap: theme.space(2) },
  dial: { width: DIAL, height: DIAL },
  dialPew: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  dotHit: { position: "absolute", width: DOT * 2, height: DOT * 2, alignItems: "center", justifyContent: "center" },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  stepButton: {
    ...dashedOutline,
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.35 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: theme.size.touch,
  },
  rowText: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body },
});

// Memoized: a streamed chunk re-renders the screen many times a second, and
// none of those chunks change anything here.
export const ConfigPicker = memo(ConfigPickerView);
