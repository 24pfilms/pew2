/**
 * Stage's button: an LED panel rather than a filled pill.
 *
 *   primary    a dotted panel washed in the agent's colour, a solid outline in
 *              that colour with a glow, and a dot-matrix label lit the same
 *              way. One per screen: the thing you came to do.
 *   secondary  the same panel unlit: dashed outline, plain label.
 *   danger     secondary in the danger tone, for leaving or deleting.
 *
 * A primary that becomes ready (mounts enabled, or turns from disabled to
 * enabled) sends one sweep of light across its dots, so the screen says "you
 * can go now" without a word. Pressing sinks it, lights the panel brighter and
 * plays the caller's haptic. Reduce Motion: no sweep, no sink; the light still
 * changes.
 *
 * Label text is one line, sentence case in the source; the LED face renders it
 * in capitals, so keep it short ("Keep GG Coder", not a sentence).
 */
import { memo, useEffect, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { theme } from "../../theme";
import { SPRING, withAlpha } from "../../motion";
import { haptics } from "../haptics";
import { useReducedMotion } from "../useReducedMotion";
import { useAgentColor } from "./agentColor";
import { DotGrid } from "./DotGrid";

export type StageButtonKind = "primary" | "secondary" | "danger";

export interface StageButtonProps {
  label: string;
  onPress: () => void;
  kind?: StageButtonKind;
  /** Overrides the agent colour (GG Goals' Ken purple, a pairing's green). */
  color?: string;
  disabled?: boolean;
  /** Haptic on press; `none` when the screen it opens makes its own. */
  feel?: keyof typeof haptics | "none";
  /** Something before the label: a DotGlyph, a spinner. */
  icon?: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  /** Shorter, for a row of two or three. */
  compact?: boolean;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SINK = SPRING.press;
const HEIGHT = 50;
const COMPACT = 42;

function StageButtonView({
  label,
  onPress,
  kind = "primary",
  color,
  disabled = false,
  feel,
  icon,
  accessibilityLabel,
  accessibilityHint,
  style,
  compact = false,
}: StageButtonProps) {
  const agent = useAgentColor();
  const reduce = useReducedMotion();
  const ink = kind === "danger" ? theme.color.danger : color ?? agent;
  const lit = kind === "primary" && !disabled;

  const scale = useSharedValue(1);
  const pressed = useSharedValue(0);
  const sweep = useSharedValue(-1);
  const width = useSharedValue(0);

  // One sweep of light when a primary becomes ready.
  const wasLit = useRef(false);
  useEffect(() => {
    if (lit && !wasLit.current && !reduce) {
      sweep.value = -1;
      sweep.value = withSequence(withTiming(-1, { duration: 120 }), withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }));
    }
    wasLit.current = lit;
  }, [lit, reduce, sweep]);

  // The ink blends on the UI thread when it changes (the agent carousel's
  // arrows), from whatever is showing, so the button recolours in place.
  const from = useSharedValue(ink);
  const to = useSharedValue(ink);
  const blend = useSharedValue(1);
  useEffect(() => {
    if (ink === to.value) return;
    from.value = interpolateColor(blend.value, [0, 1], [from.value, to.value]) as string;
    to.value = ink;
    blend.value = 0;
    blend.value = reduce ? 1 : withTiming(1, { duration: 360, easing: Easing.out(Easing.cubic) });
  }, [ink, reduce, from, to, blend]);
  const live = useAnimatedStyle(() => {
    const c = interpolateColor(blend.value, [0, 1], [from.value, to.value]) as string;
    return { borderColor: c, shadowColor: c };
  });
  const liveText = useAnimatedStyle(() => {
    const c = interpolateColor(blend.value, [0, 1], [from.value, to.value]) as string;
    return { color: c, textShadowColor: c };
  });
  const liveWash = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(blend.value, [0, 1], [from.value, to.value]) as string,
  }));

  const body = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const wash = useAnimatedStyle(() => ({ opacity: 0.14 + pressed.value * 0.16 }));
  const band = useAnimatedStyle(() => ({
    opacity: sweep.value <= -1 || sweep.value >= 1 ? 0 : 1,
    transform: [{ translateX: ((sweep.value + 1) / 2) * (width.value + 80) - 80 }, { skewX: "-20deg" }],
  }));

  const height = compact ? COMPACT : HEIGHT;
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onLayout={(e) => {
        width.value = e.nativeEvent.layout.width;
      }}
      onPressIn={() => {
        pressed.value = withTiming(1, { duration: 90 });
        if (!reduce) scale.value = withSpring(0.97, SINK);
      }}
      onPressOut={() => {
        pressed.value = withTiming(0, { duration: 220 });
        scale.value = withSpring(1, SINK);
      }}
      onPress={() => {
        const f = feel ?? (kind === "danger" ? "warned" : "tap");
        if (f !== "none") haptics[f]();
        onPress();
      }}
      style={[
        styles.base,
        { height, borderRadius: height / 2 },
        lit ? styles.lit : styles.unlit,
        lit && live,
        kind === "danger" && !disabled && { borderColor: withAlpha(ink, 0.55) },
        disabled && styles.disabled,
        body,
        style,
      ]}
    >
      {/* Clipped panel: dot texture, the colour wash, and the light sweep. */}
      <View style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: height / 2 }]} pointerEvents="none">
        <DotGrid fine />
        {lit ? <Animated.View style={[StyleSheet.absoluteFill, liveWash, wash]} /> : null}
        {lit ? <Animated.View style={[styles.band, band]} /> : null}
      </View>
      <View style={styles.row}>
        {icon}
        <Animated.Text
          numberOfLines={1}
          style={[
            styles.label,
            { color: kind === "danger" ? ink : disabled ? theme.color.textDim : theme.color.text },
            lit && styles.litText,
            lit && liveText,
          ]}
        >
          {label}
        </Animated.Text>
      </View>
    </AnimatedPressable>
  );
}

export const StageButton = memo(StageButtonView);

const styles = StyleSheet.create({
  base: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderStyle: "solid",
    backgroundColor: theme.stage.strip,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space(5),
  },
  lit: { shadowOpacity: 0.55, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  litText: { textShadowRadius: 8, textShadowOffset: { width: 0, height: 0 } },
  // Resting secondary: a dashed outline, the way unchosen things look in Stage.
  unlit: { borderStyle: "dashed", borderColor: theme.stage.dash },
  disabled: { opacity: 0.55 },
  clip: { overflow: "hidden" },
  band: { position: "absolute", top: -10, bottom: -10, width: 46, backgroundColor: "rgba(255,255,255,0.16)" },
  row: { flexDirection: "row", alignItems: "center", gap: theme.space(2), maxWidth: "100%" },
  label: {
    fontFamily: theme.display.regular,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
});
