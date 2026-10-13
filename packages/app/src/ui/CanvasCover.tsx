/**
 * Canvas-coloured, progressively blurred cover for the nav and composer rails.
 *
 * The tint always uses the conversation canvas's exact RGB (`theme.color.bg`,
 * derived via `canvasOverlay(theme.color.bg)`, never a literal: a literal went
 * stale when the palette moved and both rails turned lighter than the thread).
 *
 * Under the tint sits ONE `BlurView` per rail, masked by a vertical gradient
 * (`MaskedView` + `LinearGradient`): full strength from the screen edge to
 * `height`, then fading to nothing across a FADE band that reaches into the
 * content. The tint fades over the same band. So text passing under a rail is
 * blurred and dimmed, and there is no line where the rail ends — the earlier
 * flat overlay had a hard edge at exactly `height`.
 *
 * Why the blur is back: it was removed when the overlay sat at 92% of the
 * canvas, which left almost none of it visible. The tint here is lighter
 * (BLUR_TINT_ALPHA) so the blur actually reads. Cost is bounded: one native
 * blur per rail, static mask, no per-frame JS. With Reduce Transparency on,
 * or on Android (where expo-blur is an experimental, costly approximation),
 * it falls back to the flat overlay — still with the gradient tail, so the
 * edge stays soft.
 */
import MaskedView from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { memo, useEffect, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { canvasOverlay } from "./canvasOverlay";

// The exact canvas RGB: the flat fallback's colour.
const CANVAS_OVERLAY = canvasOverlay(theme.color.bg);
// Lighter tint over the blur, so the blur is visible but text stays quiet.
const BLUR_TINT_ALPHA = 0.55;
const BLUR_TINT = canvasOverlay(theme.color.bg, BLUR_TINT_ALPHA);
const CLEAR = canvasOverlay(theme.color.bg, 0);
// How far past `height` the cover fades out into the content.
const FADE = 28;
const BLUR_INTENSITY = 40;

interface CanvasCoverProps {
  /** The zone covered at full strength; a FADE-pt soft tail extends beyond it. */
  height: number;
  /** Which screen edge the cover is attached to. */
  edge?: "top" | "bottom";
  style?: object;
}

function useReduceTransparency(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((v) => {
      if (live) setOn(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setOn);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return on;
}

function CanvasCoverView({ height, edge = "top", style }: CanvasCoverProps) {
  const reduce = useReduceTransparency();
  const blur = !reduce && Platform.OS === "ios";
  const total = height + FADE;
  const solid = total > 0 ? height / total : 0;
  // Gradients run from the screen edge (start) toward the content (end).
  const start = edge === "top" ? { x: 0, y: 0 } : { x: 0, y: 1 };
  const end = edge === "top" ? { x: 0, y: 1 } : { x: 0, y: 0 };
  const locations = [0, solid, 1] as const;
  const tint = blur ? BLUR_TINT : CANVAS_OVERLAY;

  return (
    <View
      style={[styles.container, edge === "top" ? styles.top : styles.bottom, { height: total }, style]}
      pointerEvents="none"
    >
      {blur && (
        <MaskedView
          style={StyleSheet.absoluteFill}
          maskElement={
            <LinearGradient
              style={StyleSheet.absoluteFill}
              colors={["black", "black", "transparent"]}
              locations={locations}
              start={start}
              end={end}
            />
          }
        >
          <BlurView style={StyleSheet.absoluteFill} intensity={BLUR_INTENSITY} tint="dark" />
        </MaskedView>
      )}
      <LinearGradient
        style={StyleSheet.absoluteFill}
        colors={[tint, tint, CLEAR]}
        locations={locations}
        start={start}
        end={end}
      />
    </View>
  );
}

// Memoized: both rails live in the root screen, which re-renders on every
// keystroke, and neither cover depends on anything that changes when it does.
// Callers pass `StyleSheet` references rather than inline objects, so the
// shallow comparison actually holds.
export const CanvasCover = memo(CanvasCoverView);

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    overflow: "hidden",
  },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
