/**
 * GG Coder's `.dissolve-in` / `.dissolve-swap` for native.
 *
 * Content resolves in place: opacity plus a hair of scale standing in for the
 * desktop's blur (a live-view blur costs an offscreen pass per frame on iOS).
 * Never slides. Reduced motion is a 160ms plain fade. Nothing is held at rest:
 * once finished, the view is opacity 1 / scale 1 with no running worklet.
 *
 * `<Dissolve>` plays once per mount. Re-key it to replay (`dissolveKey`), which
 * is how a label swap works: `<Dissolve kind="swap" dissolveKey={label}>`.
 * `enabled={false}` renders the children settled, for replayed history and
 * recycled cells that must not animate.
 */
import { useEffect, type ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { dissolvePlan, type DissolveKind } from "../../motion";
import { useReducedMotion } from "../useReducedMotion";

export interface DissolveProps {
  children?: ReactNode;
  /** "in" (default) mounts, "swap" re-keyed text, "restore" history over a skeleton, "row" opacity-only list rows. */
  kind?: DissolveKind;
  /** Change to replay the entrance (label swaps). */
  dissolveKey?: string | number;
  /** ms before starting: stagger a few bands top to bottom. */
  delay?: number;
  /** False renders settled with no animation. */
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
  pointerEvents?: "auto" | "none" | "box-none" | "box-only";
}

export function Dissolve({ children, kind = "in", dissolveKey, delay = 0, enabled = true, style, pointerEvents }: DissolveProps) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(enabled ? 0 : 1);
  const plan = dissolvePlan(kind, reduceMotion, delay);
  const { fromOpacity, fromScale } = plan;

  useEffect(() => {
    if (!enabled) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    const [a, b, c, d] = plan.easing;
    progress.value = withDelay(plan.delay, withTiming(1, { duration: plan.duration, easing: Easing.bezier(a, b, c, d) }));
    return () => cancelAnimation(progress);
    // Replays only on a new key or toggling on; the plan is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dissolveKey, enabled, reduceMotion]);

  const animated = useAnimatedStyle(() => {
    const t = progress.value;
    const scale = fromScale + (1 - fromScale) * t;
    return {
      opacity: fromOpacity + (1 - fromOpacity) * t,
      transform: scale === 1 ? [] : [{ scale }],
    };
  });

  return (
    <Animated.View style={[style, animated]} pointerEvents={pointerEvents}>
      {children}
    </Animated.View>
  );
}
