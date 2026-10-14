import { expect, test } from "bun:test";
import { asRecord, asString } from "./record.js";

test("asRecord narrows objects and arrays, and nothing else", () => {
  expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  const list = [1];
  expect(asRecord(list)).toBe(list as unknown as Record<string, unknown>);
  for (const value of [null, undefined, "x", 0, true]) expect(asRecord(value)).toBeUndefined();
});

test("a chain of asRecord reads like optional chaining", () => {
  const payload: unknown = { update: { sessionUpdate: "usage_update" } };
  expect(asRecord(asRecord(payload)?.update)?.sessionUpdate).toBe("usage_update");
  expect(asRecord(asRecord("nope")?.update)?.sessionUpdate).toBeUndefined();
});

test("asString keeps strings only", () => {
  expect(asString("")).toBe("");
  expect(asString(3)).toBeUndefined();
});
