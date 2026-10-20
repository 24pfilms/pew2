import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AgentSession } from "./connect.js";
import { countProjectMentions, hydrateStudioTopics, topicsFrom } from "./ggcoder-topics.js";

const NAMES = ["internet-message-globe", "internet-message-globe-v2", "atlas-samples", "StyleClone Test"];

function count(line: string): Map<string, number> {
  const into = new Map<string, number>();
  countProjectMentions(line, NAMES, into);
  return into;
}

test("a mention counts only as a path into projects, in either slash, however JSON escaped it", () => {
  expect(count(String.raw`"L:\\Orca\\projects\\atlas-samples\\renders\\a.mp4"`).get("atlas-samples")).toBe(1);
  expect(count("see projects/atlas-samples/reference").get("atlas-samples")).toBe(1);
  expect(count(String.raw`projects\atlas-samples`).get("atlas-samples")).toBe(1);
  // The bare word, or another folder's, is not a path into the project.
  expect(count("the atlas-samples render looks good").get("atlas-samples")).toBeUndefined();
  expect(count("scratch/atlas-samples/x.png").get("atlas-samples")).toBeUndefined();
});

test("a name never matches inside a longer one, and names with spaces work", () => {
  const counts = count("projects/internet-message-globe-v2/out.mp4 and projects/internet-message-globe/old.mp4");
  expect(counts.get("internet-message-globe-v2")).toBe(1);
  expect(counts.get("internet-message-globe")).toBe(1);
  expect(count("projects/StyleClone Test/plan.md").get("StyleClone Test")).toBe(1);
});

test("topics need enough mentions, come most-worked first, and are capped", () => {
  const topics = topicsFrom(
    new Map([
      ["a", 40],
      ["b", 3],
      ["c", 2],
      ["d", 12],
      ["e", 5],
    ]),
  );
  expect(topics).toEqual(["a", "d", "e"]);
});

test("every part of a compacted conversation counts, archives included, and redirects are not read twice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-topics-"));
  const cwd = String.raw`L:\Studio`;
  const directory = path.join(root, "L_Studio");
  await mkdir(directory, { recursive: true });
  const header = (id: string, generation: number) =>
    JSON.stringify({ type: "session", version: 2, id, conversationId: "conv-1", generation, cwd });
  const say = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: text } });
  // Generation 0 (archived): the early work, in atlas-samples.
  const archived = [header("gen0", 0), say("projects/atlas-samples/a"), say("projects/atlas-samples/b"), say("projects/atlas-samples/c")].join("\n");
  await writeFile(path.join(directory, "2026-10-17T00-00-00-000Z_gen0.jsonl.gz"), gzipSync(`${archived}\n`));
  await writeFile(path.join(directory, "2026-10-17T00-00-00-000Z_gen0.jsonl"), JSON.stringify({ type: "gg_session_redirect", target: "x.gz" }));
  // Generation 1 (live): the later work, in the globe.
  const live = [header("gen1", 1), ...Array.from({ length: 5 }, () => say("projects/internet-message-globe-v2/out.mp4"))].join("\n");
  await writeFile(path.join(directory, "2026-10-20T00-00-00-000Z_gen1.jsonl"), `${live}\n`);
  // Another conversation entirely: must not leak in.
  const other = [JSON.stringify({ type: "session", id: "solo", cwd }), ...Array.from({ length: 9 }, () => say("projects/StyleClone Test/x"))].join("\n");
  await writeFile(path.join(directory, "2026-10-19T00-00-00-000Z_solo.jsonl"), `${other}\n`);

  // Listed by its newest file's id, as the agent lists a compacted conversation.
  const sessions: AgentSession[] = [
    { sessionId: "gen1", cwd },
    { sessionId: "solo", cwd },
  ];
  await hydrateStudioTopics(
    sessions,
    NAMES.map((name) => ({ name, path: `${cwd}\\projects\\${name}` })),
    [root],
  );
  expect(sessions[0]!.topics).toEqual(["internet-message-globe-v2", "atlas-samples"]);
  expect(sessions[1]!.topics).toEqual(["StyleClone Test"]);
});
