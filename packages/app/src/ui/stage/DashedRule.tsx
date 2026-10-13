/**
 * Stage's divider: a 1pt dashed line.
 *
 * React Native draws `borderStyle: "dashed"` only when all four sides carry it,
 * so this clips a dashed box to its top edge. A solid hairline would be the
 * only solid line in a dashed screen.
 */
import { memo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "../../theme";

interface DashedRuleProps {
  color?: string;
  /** A column divider rather than a row divider. */
  vertical?: boolean;
  /** Dots instead of dashes, and how thick (a wire is 2). */
  dotted?: boolean;
  weight?: number;
  style?: StyleProp<ViewStyle>;
}

function DashedRuleView({ color = theme.stage.dash, vertical = false, dotted = false, weight = 1, style }: DashedRuleProps) {
  return (
    <View
      style={[vertical ? { width: weight, alignSelf: "stretch", overflow: "hidden" } : { height: weight, alignSelf: "stretch", overflow: "hidden" }, style]}
      pointerEvents="none"
    >
      <View
        style={[
          vertical ? { width: weight * 4, flex: 1 } : { height: weight * 4 },
          { borderWidth: weight, borderStyle: dotted ? "dotted" : "dashed", borderRadius: 1, borderColor: color },
        ]}
      />
    </View>
  );
}

export const DashedRule = memo(DashedRuleView);

/** A resting card or chip outline: dashed, so a selected one (solid) stands out. */
export const dashedOutline = {
  borderWidth: 1,
  borderStyle: "dashed",
  borderColor: theme.stage.dash,
} as const;

