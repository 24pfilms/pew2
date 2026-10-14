/**
 * Shared control primitives.
 *
 * Every interactive surface in the app is one of these three shapes, so press
 * feedback, radii, touch targets and disabled treatment stay identical
 * everywhere rather than being re-styled per screen.
 *
 * That includes touch feedback: because every button routes through here, a tap
 * feels the same app-wide without a single call site opting in.
 */
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { theme } from "../theme";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { Glass } from "./Glass";
import { useAgentColor } from "./stage/agentColor";
import { GlyphLitContext } from "./stage/DotGlyph";
import { DotGrid } from "./stage/DotGrid";
import { haptics } from "./haptics";
import { SPRING } from "../motion";

/**
 * Wrap a press handler so it pulses first.
 *
 * `feel` lets a control say what its press means — sending is not the same
 * event as opening a menu — while defaulting to the ordinary tap.
 */
function withHaptic(onPress: () => void, feel: () => void = haptics.tap) {
  return () => {
    feel();
    onPress();
  };
}

/** Expands a sub-44pt control to the platform minimum touch target. */
export function touchSlop(size: number) {
  const slop = Math.max(0, (theme.size.touch - size) / 2);
  return { top: slop, bottom: slop, left: slop, right: slop };
}

interface CircleButtonProps {
  onPress: () => void;
  label: string;
  children: ReactNode;
  size?: number;
  disabled?: boolean;
  tint?: string;
  style?: ViewStyle;
  /** Override the press sensation, for controls that commit rather than open. */
  feel?: () => void;
}

/**
 * Round icon button: menu, send, composer actions.
 *
 * Stage-styled: a near-black dotted well inside a dashed ring. Under the
 * finger the ring turns solid in the agent colour, a DotGlyph child lights up
 * (via `GlyphLitContext`), and the button springs down a touch.
 */
export function CircleButton({
  onPress,
  label,
  children,
  size = theme.size.control,
  disabled = false,
  tint,
  style,
  feel,
}: CircleButtonProps) {
  const press = withHaptic(onPress, feel);
  const agent = useAgentColor();
  const reduceMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const scale = useSharedValue(1);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const active = pressed && !disabled;

  const setDown = (down: boolean) => {
    setPressed(down);
    if (reduceMotion) return;
    scale.value = withSpring(down ? 0.94 : 1, SPRING.press);
  };

  return (
    <Animated.View style={[{ width: size, height: size }, scaleStyle, style]}>
      <Pressable
        onPress={press}
        onPressIn={() => setDown(true)}
        onPressOut={() => setDown(false)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        hitSlop={touchSlop(size)}
        style={[
          styles.circle,
          styles.stageCircle,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: tint ?? theme.stage.strip,
          },
          active && { borderStyle: "solid", borderColor: agent },
          disabled && styles.disabled,
        ]}
      >
        {tint ? null : <DotGrid fine />}
        <GlyphLitContext.Provider value={active ? agent : null}>{children}</GlyphLitContext.Provider>
      </Pressable>
    </Animated.View>
  );
}

interface PillProps {
  onPress?: () => void;
  label: string;
  children: ReactNode;
  disabled?: boolean;
  /** Override the press sensation. */
  feel?: () => void;
}

/** Horizontal pill: the provider selector and the quick-action chips. */
export function Pill({ onPress, label, children, disabled = false, feel }: PillProps) {
  const content = <View style={styles.pillRow}>{children}</View>;

  if (!onPress) {
    return (
      <Glass radius={theme.radius.pill} style={styles.pillGlass}>
        <View style={styles.pill} accessibilityLabel={label}>
          {content}
        </View>
      </Glass>
    );
  }

  return (
    <Glass radius={theme.radius.pill} interactive style={styles.pillGlass}>
      <Pressable
        onPress={withHaptic(onPress, feel)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          styles.pill,
          pressed && !disabled && styles.pressedOverlay,
          disabled && styles.disabled,
        ]}
      >
        {content}
      </Pressable>
    </Glass>
  );
}

/** Small muted caption used inside pills and rows. */
export function Caption({ children }: { children: ReactNode }) {
  return <Text style={styles.caption}>{children}</Text>;
}

const styles = StyleSheet.create({
  circle: { alignItems: "center", justifyContent: "center" },
  // One dashed ring all the way round: iOS only dashes a border when all four
  // sides share it, which a full circle does.
  stageCircle: {
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth > 0.5 ? StyleSheet.hairlineWidth : 1,
    borderStyle: "dashed",
    borderColor: theme.stage.dash,
  },
  // A pill in a crowded row must be able to give up width, and every layer down
  // to the label needs to say so — one rigid ancestor and the text below it can
  // never truncate, so the pill overflows the row instead.
  pillGlass: { flexShrink: 1, minWidth: 0 },
  pill: {
    height: theme.size.control,
    paddingHorizontal: theme.space(4),
    justifyContent: "center",
    flexShrink: 1,
    minWidth: 0,
  },
  pillRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    flexShrink: 1,
    minWidth: 0,
  },
  pressed: { backgroundColor: theme.color.surfacePressed },
  // On glass, press brightens the surface rather than replacing its colour.
  pressedOverlay: { backgroundColor: theme.glass.fillPressed },
  disabled: { opacity: 0.4 },
  caption: { color: theme.color.textDim, fontSize: theme.font.small },
});
