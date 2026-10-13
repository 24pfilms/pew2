/**
 * A dot-matrix label: the LED type Stage uses for kickers, tickers, receipts
 * and counters. Uppercase, tracked out, and lit: a glow in its own colour,
 * which is the agent's colour unless a tone says otherwise.
 *
 * Only ever a label. Bitcount is unreadable as a paragraph, so anything longer
 * than a few words stays on the system font. One line, always: an LED strip
 * that wraps stops reading as one.
 */
import { memo } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { theme } from "../../theme";
import { withAlpha } from "../../motion";
import { useAgentColor } from "./agentColor";

export type LedTone = "agent" | "dim" | "attention" | "plus" | "minus" | "danger" | "text";

export interface LedProps {
  children: React.ReactNode;
  tone?: LedTone;
  /** Overrides the tone's colour (a worker's role colour, a provider's brand). */
  color?: string;
  size?: number;
  /** Unlit: no glow. Dim tone is always unlit. */
  unlit?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

const TONE: Record<Exclude<LedTone, "agent">, string> = {
  dim: theme.color.textDim,
  attention: theme.color.attention,
  plus: theme.color.success,
  minus: theme.color.danger,
  danger: theme.color.danger,
  text: theme.color.text,
};

function LedView({ children, tone = "agent", color, size = theme.stage.ledSize, unlit = false, style, numberOfLines = 1 }: LedProps) {
  const agent = useAgentColor();
  const ink = color ?? (tone === "agent" ? agent : TONE[tone]);
  const lit = !unlit && tone !== "dim";
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: theme.display.regular,
          fontSize: size,
          lineHeight: Math.round(size * 1.3),
          letterSpacing: theme.stage.ledSpacing,
          textTransform: "uppercase",
          color: ink,
        },
        lit && { textShadowColor: withAlpha(ink, 0.65), textShadowRadius: theme.stage.glow, textShadowOffset: { width: 0, height: 0 } },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export const Led = memo(LedView);
