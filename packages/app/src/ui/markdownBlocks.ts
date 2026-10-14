/**
 * Splits a message into its top-level markdown blocks.
 *
 * This exists for streaming. A reply arrives a few characters at a time, and
 * rendering it meant handing the *entire* accumulated string back to the
 * markdown renderer on every chunk — re-tokenising, rebuilding the AST, and
 * rebuilding every element for text that had not changed since the last frame.
 * The cost of a chunk therefore grew with the length of the answer, so long
 * replies got visibly slower the longer they ran, which is the opposite of what
 * a transcript should do.
 *
 * Split into blocks, the paragraphs already on screen are byte-identical from
 * one chunk to the next, so a memo keeps them and only the block still being
 * written is re-parsed. Cost per chunk becomes a function of the last paragraph
 * rather than of the whole message.
 *
 * Boundaries come from markdown-it — the same parser the renderer itself uses,
 * so the segmentation cannot disagree with how the text is ultimately read. It
 * matters that this is a real parser rather than a split on blank lines: a list
 * is a single top-level token no matter how many blank lines sit between its
 * items, so an ordered list survives as one block and keeps its numbering.
 * Splitting on blank lines would restart it at 1 partway down.
 */
import MarkdownIt from "markdown-it";

// `typographer` matches the renderer's own default instance. It only affects
// inline replacements, never block boundaries, but keeping the options in step
// means this parser and the rendering one can never disagree.
const parser = MarkdownIt({ typographer: true });

/**
 * Top-level blocks, in order, each the exact source text it was cut from.
 *
 * Blank lines between blocks are dropped: they carry no content, and spacing
 * between blocks comes from the block styles rather than from the source.
 */
export function splitMarkdownBlocks(source: string): string[] {
  if (!source) return [];

  const lines = source.split("\n");
  const blocks: string[] = [];

  for (const token of parser.parse(source, {})) {
    // `level === 0` is what makes these the *top* level: a list's items and a
    // paragraph's inline run are nested deeper and belong to the block that
    // contains them, not beside it.
    //
    // `nesting !== -1` drops closing tokens, which repeat the opening token's
    // line map and would otherwise emit every container twice.
    //
    // `map` is the token's [start, end) line range, and is absent on inline
    // tokens — the only ones that reach here have it, but it is also what the
    // slice below needs, so it is checked rather than asserted.
    if (token.level !== 0 || token.nesting === -1 || !token.map) continue;
    blocks.push(lines.slice(token.map[0], token.map[1]).join("\n"));
  }

  // A parser that found no block token still has to render something, or a
  // message would vanish rather than merely be laid out oddly.
  return blocks.length > 0 ? blocks : [source];
}

/** The block holds a fenced code block (opened, or opened and closed). */
export function hasFence(block: string): boolean {
  return /^\s*(`{3,}|~{3,})/m.test(block);
}

/**
 * Hold back a half-written inline code span while text is being revealed.
 *
 * Mid-stream, `see \`curs` is a lone backtick: markdown renders it as literal
 * prose, then restyles the whole run as code the moment the closer lands — a
 * visible flash. Cutting the revealed text back to just before an unmatched
 * backtick in the last block keeps the reveal on prose until the span is
 * whole; the code then arrives in one piece. Fenced blocks are not touched
 * (the live path never paces them).
 */
export function holdOpenInlineCode(text: string): string {
  const lastBlockStart = text.lastIndexOf("\n\n") + 1;
  const tail = text.slice(lastBlockStart);
  if (hasFence(tail)) return text;
  // A span opens with a run of N backticks and closes only at the next run of
  // exactly N; shorter or longer runs inside it are its content.
  let open: { length: number; at: number } | undefined;
  for (const run of tail.matchAll(/`+/g)) {
    const length = run[0].length;
    if (!open) open = { length, at: run.index! };
    else if (length === open.length) open = undefined;
  }
  return open ? text.slice(0, lastBlockStart + open.at) : text;
}
