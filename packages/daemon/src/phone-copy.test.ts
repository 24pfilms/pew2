/**
 * Copies are made a few at a time, and one that fails does not hold up the rest.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RUNS, phoneCopy, type PhoneCopyKind } from "./phone-copy.js";

const KIND: PhoneCopyKind = { folder: "test-copies", ext: "bin", keep: 100, label: "test" };

test("thirty asks at once run a few encoders at a time, and a failure frees its turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "pew2-copies-"));
  let now = 0;
  let peak = 0;
  const asks = Array.from({ length: 30 }, (_, i) =>
    phoneCopy(
      KIND,
      { path: `L:/pictures/${i}.png`, size: 1000 + i, mtimeMs: 1 },
      async (output) => {
        peak = Math.max(peak, ++now);
        await new Promise((done) => setTimeout(done, 5));
        now--;
        if (i % 7 === 0) throw new Error(`copy ${i} failed`);
        writeFileSync(output, `copy ${i}`);
      },
      { PEW2_HOME: home },
    ),
  );
  const outcomes = await Promise.allSettled(asks);
  expect(peak).toBe(MAX_RUNS);
  expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(5); // 0, 7, 14, 21, 28
  const made = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value.toString()] : []));
  expect(made).toHaveLength(25);
  expect(made[0]).toBe("copy 1");
});
