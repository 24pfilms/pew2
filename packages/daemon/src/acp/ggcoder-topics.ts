/**
 * Which studio projects a GG Coder / OrcaCoder conversation worked in.
 *
 * In a studio (see `studio.ts`) every chat runs at the top level, and one chat
 * wanders across several of its projects: a week-long Orcastrator conversation,
 * compacted ten times, still titled by the first thing it was asked, did most
 * of its work in three projects it never mentioned in that title. So the chat's
 * own words are read for paths into `projects/<name>`, across every part of the
 * conversation (each compaction starts a new file), and the projects mentioned
 * most become its topics.
 *
 * Read straight from the agent's own store, like the message counts beside it,
 * because asking the agent to replay a transcript costs seconds per chat. Files
 * are read line by line and never held whole; each file's counts are cached by
 * its size and modification time, so only a chat that changed is read again.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createGunzip } from "node:zlib";
import type { wire } from "@pew2/protocol";
import type { AgentSession } from "./connect.js";
import { encodeCwd, ggcoderSessionRoots } from "./ggcoder-history.js";

/** Mentions a project needs before it counts as something the chat worked in. */
export const MIN_TOPIC_MENTIONS = 3;
/** Topics kept per conversation, most-worked first. */
export const MAX_TOPICS = 3;
/** Characters that continue a folder name: `globe` must not match inside `globe-v2`. */
const NAME_CHAR = /[A-Za-z0-9_.-]/;

/**
 * Mentions of each name as a path into the studio's `projects` folder in one
 * line of a stored transcript: `projects/<name>` or `projects\<name>`, written
 * with any number of backslashes (JSON doubles them), and only where the name
 * ends there.
 */
export function countProjectMentions(line: string, names: readonly string[], into: Map<string, number>) {
  if (!line.includes("projects")) return;
  for (const name of names) {
    let from = 0;
    for (;;) {
      const at = line.indexOf(name, from);
      if (at < 0) break;
      from = at + name.length;
      if (NAME_CHAR.test(line.charAt(at + name.length))) continue;
      // Walk back over the separators to the word before them.
      let cut = at;
      while (cut > 0 && (line[cut - 1] === "/" || line[cut - 1] === "\\")) cut -= 1;
      if (cut === at) continue;
      if (!line.slice(Math.max(0, cut - 8), cut).toLowerCase().endsWith("projects")) continue;
      into.set(name, (into.get(name) ?? 0) + 1);
    }
  }
}

/** The topics for a set of counts: enough mentions, most first, a few at most. */
export function topicsFrom(counts: ReadonlyMap<string, number>): string[] {
  return [...counts]
    .filter(([, count]) => count >= MIN_TOPIC_MENTIONS)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOPICS)
    .map(([name]) => name);
}

/** Per file: what was counted, and for which list of names. */
const fileCounts = new Map<string, { size: number; mtimeMs: number; names: string; counts: Map<string, number> }>();

async function countFile(file: string, names: readonly string[], namesKey: string): Promise<Map<string, number>> {
  const info = await stat(file);
  const cached = fileCounts.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.names === namesKey) {
    return cached.counts;
  }
  const counts = new Map<string, number>();
  const source = createReadStream(file);
  const input = file.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) countProjectMentions(line, names, counts);
  } finally {
    lines.close();
  }
  fileCounts.set(file, { size: info.size, mtimeMs: info.mtimeMs, names: namesKey, counts });
  return counts;
}

/** A stored file's header, or undefined when the first line is not one. */
async function readHeader(file: string): Promise<{ id?: string; conversationId?: string } | undefined> {
  const source = createReadStream(file);
  const input = file.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const header = JSON.parse(line) as { type?: string; id?: string; conversationId?: string };
      return header.type === "session" ? header : undefined;
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    source.destroy();
  }
  return undefined;
}

/**
 * Every file of every conversation in one stored project folder, grouped by
 * conversation. A tiny `.jsonl` redirect beside an archived `.jsonl.gz` is the
 * same file twice; the archive is the one with the words in it.
 */
async function conversationsIn(directory: string): Promise<Map<string, string[]>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return new Map();
  }
  const files = names
    .filter((name) => name.endsWith(".jsonl.gz") || (name.endsWith(".jsonl") && !names.includes(`${name}.gz`)))
    .map((name) => path.join(directory, name));
  const byConversation = new Map<string, string[]>();
  for (const file of files) {
    const header = await readHeader(file);
    if (!header?.id) continue;
    const conversation = header.conversationId ?? header.id;
    byConversation.set(conversation, [...(byConversation.get(conversation) ?? []), file]);
    // The file's own id too, so a session listed by its newest file is found.
    if (conversation !== header.id) byConversation.set(`id:${header.id}`, [conversation]);
  }
  return byConversation;
}

/**
 * Fill `topics` on each listed conversation of a studio, in place, from the
 * agent's own store. Best effort: a conversation that cannot be read is left
 * without topics, never failed.
 */
export async function hydrateStudioTopics(
  sessions: AgentSession[],
  studio: readonly wire.StudioProject[],
  sessionsRoots: string[] = ggcoderSessionRoots(),
): Promise<void> {
  const names = studio.map((project) => project.name);
  if (names.length === 0 || sessions.length === 0) return;
  const namesKey = names.join("\u0000");
  const folders = new Map<string, Map<string, string[]>>();
  for (const session of sessions) {
    try {
      let files: string[] | undefined;
      for (const root of sessionsRoots) {
        const directory = path.join(root, encodeCwd(session.cwd));
        let index = folders.get(directory);
        if (!index) {
          index = await conversationsIn(directory);
          folders.set(directory, index);
        }
        const conversation = index.get(`id:${session.sessionId}`)?.[0] ?? session.sessionId;
        files = index.get(conversation);
        if (files?.length) break;
      }
      if (!files?.length) continue;
      const total = new Map<string, number>();
      for (const file of files) {
        for (const [name, count] of await countFile(file, names, namesKey)) {
          total.set(name, (total.get(name) ?? 0) + count);
        }
      }
      const topics = topicsFrom(total);
      if (topics.length > 0) session.topics = topics;
    } catch (error) {
      console.error(`[studio] could not read the topics of ${session.sessionId}:`, error);
    }
  }
}
