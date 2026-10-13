import { expect, test } from "bun:test";
import { hidePartialKenLine, latestKenSaying, splitKenLine, withoutKenLines } from "./kenLine";

test("takes the last line off and keeps it", () => {
  expect(splitKenLine("Done the tests.\n\n[ken:proud] All **green** now.")).toEqual({
    body: "Done the tests.",
    line: { face: "proud", text: "All green now." },
  });
});

test("unknown faces fall back to neutral; backticks tolerated", () => {
  expect(splitKenLine("x\n`[ken:sleepy]` zz").line).toEqual({ face: "neutral", text: "zz" });
});

test("no marker leaves the text alone", () => {
  expect(splitKenLine("plain\ntext")).toEqual({ body: "plain\ntext", line: null });
});

test("an opening line is said but its words stay", () => {
  const split = splitKenLine("[ken:happy] Shipped it.\nDetails follow.");
  expect(split.line).toEqual({ face: "happy", text: "Shipped it." });
  expect(split.body).toBe("Shipped it.\nDetails follow.");
});

test("a partial marker never flashes while streaming", () => {
  expect(hidePartialKenLine("Working\n[ke")).toBe("Working");
  expect(hidePartialKenLine("Working\n[ken:wor")).toBe("Working");
});

test("long lines clip at a word", () => {
  const line = splitKenLine(`a\n[ken:happy] ${"word ".repeat(40)}`).line;
  expect(line?.text.endsWith("…")).toBe(true);
  expect((line?.text.length ?? 0) <= 140).toBe(true);
});

test("latest saying and stripped transcript", () => {
  const turns = [
    { role: "agent", text: "one\n[ken:sad] Oops." },
    { role: "user", text: "[ken:happy] not mine" },
    { role: "agent", text: "two" },
  ];
  expect(latestKenSaying(turns)).toEqual({ face: "sad", text: "Oops." });
  const stripped = withoutKenLines(turns);
  expect(stripped[0]?.text).toBe("one");
  expect(stripped[1]).toBe(turns[1]);
  expect(stripped[2]).toBe(turns[2]);
});
