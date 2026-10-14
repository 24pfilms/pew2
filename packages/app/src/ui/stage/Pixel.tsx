/**
 * Row-level status, as LED pixels rather than badges:
 *   live       a three-bar equaliser, pulsing in the agent's colour (working)
 *   attention  one amber pixel that blinks (waiting on you)
 *   unread     one steady pixel in the agent's colour (a reply you haven't seen)
 *
 * Under Reduce Motion, or `paused`, the equaliser and the blink hold still:
 * the state still reads, it just doesn't move.
 */
import { memo, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { theme } from "../../theme";
import { withAlpha } from "../../motion";
import { useReducedMotion } from "../useReducedMotion";
import { useAgentColor } from "./agentColor";

export type PixelKind = "live" | "attention" | "unread";

function Bar({ delay, color, still }: { delay: number; color: string; still: boolean }) {
  const h = useSharedValue(still ? 1 : 0.35);
  useEffect(() => {
    if (still) {
      cancelAnimation(h);
      h.value = 0.8;
      return;
    }
    h.value = withDelay(
      delay,
      withRepeat(withSequence(withTiming(1, { duration: 340, easing: Easing.inOut(Easing.quad) }), withTiming(0.3, { duration: 340, easing: Easing.inOut(Easing.quad) })), -1),
    );
    return () => cancelAnimation(h);
  }, [still, delay, h]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: h.value }] }));
  return <Animated.View style={[styles.bar, { backgroundColor: color, shadowColor: color }, style]} />;
}

function PixelView({ kind, color, paused = false }: { kind: PixelKind; color?: string; paused?: boolean }) {
  const agent = useAgentColor();
  // Paused (off screen, a closed drawer) holds still exactly like Reduce
  // Motion: the state still reads, nothing animates where nobody can see it.
  const reduce = useReducedMotion() || paused;
  const ink = color ?? (kind === "attention" ? theme.color.attention : agent);
  const blink = useSharedValue(1);
  useEffect(() => {
    if (kind !== "attention" || reduce) {
      cancelAnimation(blink);
      blink.value = 1;
      return;
    }
    blink.value = withRepeat(withSequence(withTiming(0.25, { duration: 520 }), withTiming(1, { duration: 520 })), -1);
    return () => cancelAnimation(blink);
  }, [kind, reduce, blink]);
  const blinkStyle = useAnimatedStyle(() => ({ opacity: blink.value }));

  if (kind === "live") {
    return (
      <View style={styles.eq} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {[0, 120, 240].map((d) => (
          <Bar key={d} delay={d} color={ink} still={reduce} />
        ))}
      </View>
    );
  }
  return <Animated.View style={[styles.px, { backgroundColor: ink, shadowColor: withAlpha(ink, 0.9) }, blinkStyle]} />;
}

export const Pixel = memo(PixelView);

const styles = StyleSheet.create({
  eq: { width: 12, height: 10, flexDirection: "row", alignItems: "flex-end", gap: 2 },
  bar: { width: 2.5, height: 10, borderRadius: 1, shadowOpacity: 0.9, shadowRadius: 3, shadowOffset: { width: 0, height: 0 } },
  px: { width: 6, height: 6, borderRadius: 1.5, shadowOpacity: 1, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
});
