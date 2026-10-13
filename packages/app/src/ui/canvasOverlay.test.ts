import { expect, test } from "bun:test";
import { canvasOverlay } from "./canvasOverlay";

test("the rails cover is the conversation canvas's own colour", () => {
  expect(canvasOverlay("#0a0a0c")).toBe("rgba(10,10,12,0.92)");
  expect(canvasOverlay("#111")).toBe("rgba(17,17,17,0.92)");
});

test("the cover is derived from the theme's canvas, not a literal", async () => {
  // theme.ts imports React Native, which bun cannot parse, so read its source.
  const theme = await Bun.file(new URL("../theme.ts", import.meta.url).pathname).text();
  const bg = theme.match(/\bbg:\s*"(#[0-9a-fA-F]{3,6})"/)?.[1];
  expect(bg).toBeDefined();
  const [r, g, b] = canvasOverlay(bg!).match(/\d+/g)!.map(Number);
  const hex = `#${[r, g, b].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
  expect(hex).toBe(bg!.toLowerCase());
  const cover = await Bun.file(new URL("CanvasCover.tsx", import.meta.url).pathname).text();
  expect(cover).toContain("canvasOverlay(theme.color.bg)");
});

test("no rail hard-codes a canvas colour", async () => {
  const source = await Bun.file(new URL("CanvasCover.tsx", import.meta.url).pathname).text();
  expect(source).not.toMatch(/rgba\(\s*\d/);
});
