/**
 * The LED canvas texture: a faint grid of dots behind a surface.
 *
 * Drawn once into a Skia picture for the measured size and never redrawn, so a
 * full-screen grid costs one draw call per frame the canvas is composited. It
 * sits behind content and never takes a touch.
 */
import { memo, useMemo, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Canvas, Picture, Skia } from "@shopify/react-native-skia";
import { theme } from "../../theme";

interface DotGridProps {
  /** Spacing between dots. `fine` is the strip/ticker texture. */
  fine?: boolean;
  style?: StyleProp<ViewStyle>;
}

function DotGridView({ fine = false, style }: DotGridProps) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const step = fine ? theme.stage.fine : theme.stage.grid;
  const color = fine ? theme.stage.fineColor : theme.stage.gridColor;
  const picture = useMemo(() => {
    if (size.w === 0 || size.h === 0) return null;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, size.w, size.h));
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(color));
    const r = fine ? 0.7 : theme.stage.gridDot;
    for (let y = step / 2; y < size.h; y += step) {
      for (let x = step / 2; x < size.w; x += step) canvas.drawCircle(x, y, r, paint);
    }
    return recorder.finishRecordingAsPicture();
  }, [size.w, size.h, step, color, fine]);

  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, style]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        const w = Math.ceil(width);
        const h = Math.ceil(height);
        setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }}
    >
      {picture ? (
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          <Picture picture={picture} />
        </Canvas>
      ) : null}
    </View>
  );
}

export const DotGrid = memo(DotGridView);
