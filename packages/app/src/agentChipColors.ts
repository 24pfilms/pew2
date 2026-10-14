import { contrastRatio } from "./ui/providerGradient";

interface Palette {
  surface: string; surfaceRaised: string; surfacePressed: string;
  text: string; textDim: string; orb: string;
  accent: string; accentSoft: string;
}
/**
 * Paired opaque fill/ink; never dim the entire label-bearing control.
 *
 * Selected is colour alone (the user's call, replacing a trailing tick): the
 * app's "on" fill with accent ink, the same pair every other on-state uses.
 */
export function agentChipColors(color: string | undefined, selected: boolean, enabled: boolean, palette: Palette) {
  const on = enabled && selected;
  const background = !enabled ? palette.surface : on ? palette.accentSoft : palette.surfaceRaised;
  const text = !enabled ? palette.textDim : on ? palette.accent : palette.text;
  const brand = color && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color) ? color : palette.orb;
  const marker = enabled && contrastRatio(brand, background) >= 3 ? brand : palette.textDim;
  return { background, text, marker };
}
