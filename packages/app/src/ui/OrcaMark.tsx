/**
 * The Orca mark: the Scarlet orca from Orca Master Theming
 * (`canonical/assets/orca-scarlet-icon.png`), where the app used to show a
 * dot-matrix orb.
 *
 * It breathes — a slow, small swell — while an agent is working, which is the
 * one thing the orb's sweep used to say. Still when nothing is running, when
 * the app is not on screen, and for anyone who has asked their phone to reduce
 * motion.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, Image, StyleSheet } from "react-native";
import { useAppActive } from "./useAppActive";
import { useReducedMotion } from "./useReducedMotion";

const ORCA = require("../../assets/orca-scarlet.png");

/** How far the breath swells, and how long one takes. */
const BREATH_SCALE = 1.06;
const BREATH_MS = 1400;

export function OrcaMark({ size = 96, busy = false }: { size?: number; busy?: boolean }) {
  const active = useAppActive();
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    scale.stopAnimation();
    if (!busy || reduced || !active) {
      scale.setValue(1);
      return;
    }
    const breath = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: BREATH_SCALE,
          duration: BREATH_MS,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: BREATH_MS,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    breath.start();
    return () => breath.stop();
  }, [busy, reduced, active, scale]);

  return (
    <Animated.View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, transform: [{ scale }] }}
    >
      <Image source={ORCA} style={styles.image} resizeMode="contain" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  image: { width: "100%", height: "100%" },
});
