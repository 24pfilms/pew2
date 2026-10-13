/** The Stage LED pill: dashed at rest, solid in the agent colour when lit.
 * One shape for the context row above the composer and the selectors in it.
 */
import { memo, type ReactNode } from "react";
import { StyleSheet, View, type AccessibilityRole, type AccessibilityState } from "react-native";
import { theme } from "../theme";
import { withAlpha } from "../motion";
import { dashedOutline } from "./stage/DashedRule";
import { Led, type LedTone } from "./stage/Led";
import { PressScale } from "./stage/PressScale";
import { useAgentColor } from "./stage/agentColor";
import type { haptics } from "./haptics";

/** Matches the composer's send/mic pill so a row of chips and buttons aligns. */
export const STAGE_CHIP_HEIGHT = 32;

export interface StageChipProps {
  label: string;
  /** Solid outline in the agent colour (or `attention` amber) and a glowing label. */
  lit?: boolean;
  /** Tighter padding, for a short value (a number) in a crowded row. */
  compact?: boolean;
  tone?: Extract<LedTone, "agent" | "attention" | "dim" | "danger" | "text">;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  feel?: keyof typeof haptics | "none";
  accessibilityLabel: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  accessibilityHint?: string;
  maxLabelWidth?: number;
}

function StageChipView({ label, lit = false, compact = false, tone, leading, trailing, onPress, feel = "tap", maxLabelWidth, ...a11y }: StageChipProps) {
  const agent = useAgentColor();
  const ink = tone === "attention" ? theme.color.attention : tone === "danger" ? theme.color.danger : agent;
  const ledTone = tone ?? (lit ? "agent" : "dim");
  const body = (
    <>
      {leading}
      <Led tone={ledTone} unlit={!lit} style={maxLabelWidth ? { maxWidth: maxLabelWidth, flexShrink: 1 } : undefined}>{label}</Led>
      {trailing}
    </>
  );
  const style = [styles.chip, compact && styles.compact, lit && { borderStyle: "solid" as const, borderColor: ink, backgroundColor: withAlpha(ink, 0.1) }];
  if (!onPress) return <View style={style} accessible accessibilityRole="text" accessibilityLabel={a11y.accessibilityLabel}>{body}</View>;
  return <PressScale style={style} feel={feel} onPress={onPress} {...a11y}>{body}</PressScale>;
}
export const StageChip = memo(StageChipView);

const styles = StyleSheet.create({
  compact: { paddingHorizontal: theme.space(2), gap: theme.space(1) },
  chip: {
    ...dashedOutline,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    height: STAGE_CHIP_HEIGHT,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space(3),
    flexShrink: 1,
  },
});
