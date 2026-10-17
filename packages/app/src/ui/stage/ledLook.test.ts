import { expect, test } from "bun:test";
import { ledLook, type LedLookInput } from "./ledLook";

const base: LedLookInput = {
  tone: "agent",
  agent: "#ff4d4d",
  palette: { dim: "#999999", attention: "#ffb020", plus: "#3ddc84", minus: "#ff5555", danger: "#ff3b30", text: "#f2f2f3" },
  text: "#ffffff",
  unlit: false,
  clear: true,
};

test("the clear look draws agent-coloured labels as plain white system text, with no glow", () => {
  expect(ledLook(base)).toEqual({ ink: "#ffffff", lit: false, font: "system" });
});

test("a colour chosen on purpose, or one that means something, is kept in the clear look", () => {
  expect(ledLook({ ...base, color: "#8b7cf6" })).toMatchObject({ ink: "#8b7cf6", font: "system", lit: false });
  expect(ledLook({ ...base, tone: "danger" }).ink).toBe("#ff3b30");
  expect(ledLook({ ...base, tone: "attention" }).ink).toBe("#ffb020");
  expect(ledLook({ ...base, tone: "dim" }).ink).toBe("#999999");
  expect(ledLook({ ...base, tone: "text" }).ink).toBe("#f2f2f3");
});

test("with the switch off the dotted look is exactly as it was: agent colour, glow, dot font", () => {
  const dotted = { ...base, clear: false };
  expect(ledLook(dotted)).toEqual({ ink: "#ff4d4d", lit: true, font: "dots" });
  expect(ledLook({ ...dotted, tone: "dim" })).toEqual({ ink: "#999999", lit: false, font: "dots" });
  expect(ledLook({ ...dotted, unlit: true })).toMatchObject({ lit: false, font: "dots" });
  expect(ledLook({ ...dotted, color: "#8b7cf6" })).toMatchObject({ ink: "#8b7cf6", lit: true });
});
