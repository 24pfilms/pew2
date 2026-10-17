/**
 * How a small label (`Led`) looks: its colour, whether it glows, and which font.
 *
 * Stage draws these labels as glowing, agent-coloured dot-matrix type. At 11 px
 * that is hard to read, so the clear look draws them as plain white system text
 * at the same size. The choice is one switch (`theme.stage.clearLabels`); false
 * restores the dotted look exactly. Pure, with the theme passed in, so the rule
 * is testable without the native modules.
 */

export type LedFont = "dots" | "system";

export interface LedLook {
  ink: string;
  /** Glows in its own colour. Never in the clear look: a glow smears small text. */
  lit: boolean;
  font: LedFont;
}

export interface LedLookInput {
  tone: string;
  /** A colour chosen on purpose (a worker's role, a provider's brand). */
  color?: string;
  /** The agent's colour, for the `agent` tone. */
  agent: string;
  /** Colours of the other tones (dim, attention, plus, minus, danger, text). */
  palette: Record<string, string>;
  /** The theme's plain text colour. */
  text: string;
  unlit: boolean;
  clear: boolean;
}

export function ledLook(input: LedLookInput): LedLook {
  const chosen = input.color ?? (input.tone === "agent" ? input.agent : input.palette[input.tone]!);
  // White for the labels that took the agent's colour. A colour somebody picked
  // on purpose, or one that means something (a warning, a plus, a minus), stays.
  const ink = input.clear && input.color === undefined && input.tone === "agent" ? input.text : chosen;
  return {
    ink,
    lit: !input.unlit && input.tone !== "dim" && !input.clear,
    font: input.clear ? "system" : "dots",
  };
}
