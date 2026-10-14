/**
 * Bun on Windows drops the separator from a drive root's real path: `realpath("L:\\")`
 * gives `"L:"`, which Windows reads as "the current directory on drive L". Browsing
 * a drive then listed the daemon's own folder instead of the drive.
 */
import { expect, test } from "bun:test";
import { keepDriveRoot } from "./drive-root.js";

test("a bare drive letter gets its root separator back", () => {
  expect(keepDriveRoot("L:")).toBe("L:\\");
  expect(keepDriveRoot("c:")).toBe("c:\\");
});

test("every other path is left exactly as it is", () => {
  for (const path of ["L:\\", "L:\code", "C:\Users\me", "/", "/home/me", "relative", "\\server\share"]) {
    expect(keepDriveRoot(path)).toBe(path);
  }
});
