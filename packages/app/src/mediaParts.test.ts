import { expect, test } from "bun:test";
import { MediaAssembly } from "./mediaParts";

const piece = (index: number, data: string) => ({ requestId: "r1", index, count: 3, data });

test("pieces become the whole data URI, and each is confirmed by how many have arrived in order", () => {
  const assembly = new MediaAssembly();
  expect(assembly.add(piece(0, "QUJD"))).toBe(1);
  expect(assembly.add(piece(1, "REVG"))).toBe(2);
  expect(assembly.add(piece(2, "R0g="))).toBe(3);
  expect(assembly.finish("r1", 3, "image/png")).toBe("data:image/png;base64,QUJDREVGR0g=");
});

test("a piece out of order is held, and confirmation waits for the gap to fill", () => {
  const assembly = new MediaAssembly();
  expect(assembly.add(piece(0, "a"))).toBe(1);
  expect(assembly.add(piece(2, "c"))).toBe(1);
  expect(assembly.add(piece(1, "b"))).toBe(3);
  expect(assembly.finish("r1", 3, "video/mp4")).toBe("data:video/mp4;base64,abc");
});

test("a transfer missing a piece is not passed off as whole", () => {
  const assembly = new MediaAssembly();
  assembly.add(piece(0, "a"));
  assembly.add(piece(2, "c"));
  expect(assembly.finish("r1", 3, "image/png")).toBeUndefined();
  // And it is let go: a second finish finds nothing.
  expect(assembly.finish("r1", 3, "image/png")).toBeUndefined();
});

test("clearing drops what a lost connection was carrying", () => {
  const assembly = new MediaAssembly();
  assembly.add(piece(0, "a"));
  assembly.clear();
  expect(assembly.finish("r1", 3, "image/png")).toBeUndefined();
});
