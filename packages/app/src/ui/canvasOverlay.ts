/**
 * The rails' cover colour: the canvas itself, slightly translucent.
 *
 * Pure (no React Native) so the "same colour as the thread" rule is testable.
 * Over the canvas, an overlay of the canvas's own RGB composites to exactly the
 * canvas at any alpha — the rails are only distinguishable where text passes
 * beneath them, which is the point.
 */
export const CANVAS_OVERLAY_ALPHA = 0.92;

export function canvasOverlay(canvasHex: string, alpha = CANVAS_OVERLAY_ALPHA): string {
  const hex = canvasHex.replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}
