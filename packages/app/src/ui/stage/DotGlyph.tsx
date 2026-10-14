/**
 * Icons drawn as LED pixel art: a 7x7 bitmap of rounded dots, so a button's
 * glyph reads as part of the same dot-matrix world as the labels and strips.
 *
 * Decorative: the button around it carries the accessibility label. Inside a
 * CircleButton it lights up (glows) while pressed, via `GlyphLitContext`.
 */
import { createContext, memo, useContext, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { theme } from "../../theme";

export type DotGlyphName =
  | "menu"
  | "close"
  | "back"
  | "compose"
  | "plus"
  | "pause"
  | "play"
  | "gear"
  | "chevron-down"
  | "up"
  | "down"
  | "send";

// 7x7 bitmaps, "#" = lit dot. Parsed once at module load into dot coordinates.
const BITMAPS: Record<DotGlyphName, readonly string[]> = {
  menu: [".......", "#######", ".......", "#######", ".......", "#######", "......."],
  close: ["#.....#", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#.....#"],
  back: ["....#..", "...#...", "..#....", ".#.....", "..#....", "...#...", "....#.."],
  compose: ["....##.", "...#.##", "..#.##.", ".#.##..", "#.##...", "##.....", "#######"],
  plus: ["...#...", "...#...", "...#...", "#######", "...#...", "...#...", "...#..."],
  pause: [".##.##.", ".##.##.", ".##.##.", ".##.##.", ".##.##.", ".##.##.", ".##.##."],
  play: [".#.....", ".##....", ".###...", ".####..", ".###...", ".##....", ".#....."],
  gear: ["#..#..#", ".#####.", ".##.##.", "##...##", ".##.##.", ".#####.", "#..#..#"],
  "chevron-down": [".......", ".......", "#.....#", ".#...#.", "..#.#..", "...#...", "......."],
  up: ["...#...", "..###..", ".#.#.#.", "#..#..#", "...#...", "...#...", "...#..."],
  down: ["...#...", "...#...", "...#...", "#..#..#", ".#.#.#.", "..###..", "...#..."],
  send: ["...#...", "..###..", ".#.#.#.", "#..#..#", "...#...", "...#...", "...#..."],
};

const GRID = 7;

type Dots = readonly (readonly [number, number])[];

function parse(rows: readonly string[]): Dots {
  return rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === "#" ? [[x, y] as const] : [])));
}

/** Set by a pressable parent (CircleButton) so its glyph glows under the finger. */
export const GlyphLitContext = createContext<string | null>(null);

interface DotGlyphProps {
  name: DotGlyphName;
  size?: number;
  color?: string;
  /** Glow in this glyph's colour. Defaults to the enclosing button's press state. */
  lit?: boolean;
}

function DotGlyphView({ name, size = 18, color, lit }: DotGlyphProps) {
  const litColor = useContext(GlyphLitContext);
  const on = lit ?? litColor !== null;
  const ink = color ?? (on && litColor ? litColor : theme.color.text);
  const dots = useMemo(() => parse(BITMAPS[name]), [name]);
  const step = size / GRID;
  const dot = step * 0.78;
  const inset = (step - dot) / 2;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[
        { width: size, height: size },
        on && { shadowColor: ink, shadowOpacity: 0.9, shadowRadius: theme.stage.glow / 2, shadowOffset: { width: 0, height: 0 } },
      ]}
    >
      {dots.map(([x, y]) => (
        <View
          key={`${x}-${y}`}
          style={[
            styles.dot,
            { left: x * step + inset, top: y * step + inset, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: ink },
          ]}
        />
      ))}
    </View>
  );
}

export const DotGlyph = memo(DotGlyphView);

const styles = StyleSheet.create({ dot: { position: "absolute" } });
