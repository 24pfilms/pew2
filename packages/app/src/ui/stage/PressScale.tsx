/**
 * A pressable that gives under the finger: it sinks to 97% on press and springs
 * back on release, on the UI thread. For Stage's cards and tiles, where an
 * opacity flash alone reads as flat.
 *
 * The haptic is the caller's to choose (`feel`): most presses are a `tap`,
 * picking an option is a `select`, and some presses are silent because the
 * screen they open makes its own.
 */
import { memo, type ReactNode } from "react";
import { Pressable, type AccessibilityRole, type AccessibilityState, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { haptics } from "../haptics";
import { useReducedMotion } from "../useReducedMotion";
import { SPRING } from "../../motion";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const PRESS = SPRING.press;

export interface PressScaleProps {
  onPress?: () => void;
  onLongPress?: () => void;
  feel?: keyof typeof haptics | "none";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  accessibilityHint?: string;
  hitSlop?: number;
  children: ReactNode;
}

function PressScaleView({ onPress, onLongPress, feel = "tap", disabled = false, style, children, hitSlop, accessibilityRole = "button", ...a11y }: PressScaleProps) {
  const reduce = useReducedMotion();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole={accessibilityRole}
      {...a11y}
      onPressIn={() => {
        if (!reduce) scale.value = withSpring(0.97, PRESS);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, PRESS);
      }}
      onPress={
        onPress &&
        (() => {
          if (feel !== "none") haptics[feel]();
          onPress();
        })
      }
      onLongPress={onLongPress}
      style={[style, animated, disabled && { opacity: 0.45 }]}
    >
      {children}
    </AnimatedPressable>
  );
}

export const PressScale = memo(PressScaleView);
