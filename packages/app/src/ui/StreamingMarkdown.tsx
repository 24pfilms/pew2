/**
 * Streamed words dissolve in: each new word arrives as a soft blur of its own
 * colour and resolves into sharp text (`wordDissolve`, motion.ts) — GG Coder's
 * `md-word-in` look — with native text flow.
 *
 * Built from what a span nested in a paragraph can actually draw. iOS flattens
 * nested text into one attributed string, so an animated `opacity` or a view
 * blur on a nested span never reaches the screen (that was this file before:
 * the fade existed in code and was invisible on the phone). A span's *colour*
 * (alpha included) and its *text shadow* are attributes of that string, so
 * they draw: the fill fades up while a zero-offset shadow of the same colour —
 * the blur — shrinks away.
 *
 * One clock per paragraph, on `requestAnimationFrame`, so it moves at the
 * display's own rate. It runs only while a word is resolving, and only the
 * paragraph being written ever has one; settled text is plain strings.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Markdown, { AstRenderer, renderRules, styles as defaultStyles, type ASTNode, type MarkdownStyles, type RenderRules } from "react-native-markdown-renderer";
import { DUR, withAlpha, wordDissolve } from "../motion";
import { useReducedMotion } from "./useReducedMotion";
import { normalizeMarkdownKeys, splitWords, isProsePath } from "./markdownIdentity";

const ZERO_OFFSET = { width: 0, height: 0 } as const;

function Prose({ content, animate, budget, color }: { content: string; animate: boolean; budget: number; color: string }) {
  const reduceMotion = useReducedMotion();
  // Initial history stays plain. Text that was already there when this
  // paragraph mounted (or when its stream settled) never fades.
  const [baseline, setBaseline] = useState(content);
  if (!animate && baseline !== content) setBaseline(content);

  // Which words are new enough to fade: past the baseline, not whitespace,
  // within this paragraph's share of the message's budget.
  const parts = useMemo(() => {
    let offset = 0;
    let used = 0;
    return splitWords(content).map((text) => {
      const start = offset;
      offset += text.length;
      const fades = animate && !reduceMotion && !/^\s/.test(text) && start >= baseline.length && used < budget;
      if (fades) used++;
      return { text, start, fades };
    });
  }, [content, animate, reduceMotion, baseline, budget]);

  // Birth time per word (by its offset), stamped on the first frame after it
  // renders; `now` is the clock the dissolves are read against.
  const [births, setBirths] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [now, setNow] = useState(0);
  const frame = useRef<number | undefined>(undefined);
  useEffect(() => {
    const unborn = parts.some((p) => p.fades && !births.has(p.start));
    const resolving = [...births.values()].some((at) => now - at < DUR.word);
    if (!unborn && !resolving) return;
    frame.current = requestAnimationFrame(() => {
      const t = Date.now();
      if (unborn) {
        setBirths((prev) => {
          const next = new Map(prev);
          for (const p of parts) if (p.fades && !next.has(p.start)) next.set(p.start, t);
          return next;
        });
      }
      setNow(t);
    });
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [parts, births, now]);

  if (births.size === 0 && !parts.some((p) => p.fades)) return <Text>{content}</Text>;
  return (
    <Text>
      {parts.map((p, index) => {
        const born = births.get(p.start);
        // Not stamped yet: it has just arrived, so it starts fully dissolved.
        const look = born === undefined ? (p.fades ? wordDissolve(0) : undefined) : wordDissolve(now - born);
        if (!look || look.alpha >= 1) return p.text;
        return (
          <Text
            key={index}
            style={{
              color: withAlpha(color, look.alpha),
              textShadowColor: withAlpha(color, look.glow),
              textShadowRadius: look.blur,
              textShadowOffset: ZERO_OFFSET,
            }}
          >
            {p.text}
          </Text>
        );
      })}
    </Text>
  );
}

/** The colour a text node is drawn in: its nearest styled ancestor's (link, strong…), else body text. */
function inheritedColor(parents: readonly ASTNode[], styles: Record<string, unknown>): string {
  for (const parent of parents) {
    const style = StyleSheet.flatten(styles[parent.type] as object | undefined) as { color?: unknown } | undefined;
    if (typeof style?.color === "string") return style.color;
  }
  const text = StyleSheet.flatten(styles.text as object | undefined) as { color?: unknown } | undefined;
  return typeof text?.color === "string" ? text.color : "#ffffff";
}

interface Props {
  source: string;
  animate: boolean;
  rules: RenderRules;
  style: Partial<MarkdownStyles>;
  onLinkPress: (url: string) => boolean | void;
}
export function StreamingMarkdown({ source, animate, rules, style, onLinkPress }: Props) {
  const renderer = useMemo(() => {
    const merged: MarkdownStyles = { ...defaultStyles };
    for (const [key, value] of Object.entries(style)) {
      merged[key] = { ...StyleSheet.flatten(merged[key] as object), ...StyleSheet.flatten(value as object) };
    }
    return (nodes: ASTNode[]) => {
      let budget = 128;
      const ast = new AstRenderer({
        ...renderRules, ...rules,
        text: (node, _children, parents, styles) => {
          if (!isProsePath(parents.map((p) => p.type))) return renderRules.text!(node, [], parents, styles);
          const allowance = Math.min(budget, splitWords(node.content).filter((part) => !/^\s/.test(part)).length);
          budget -= allowance;
          return <Prose key={node.key} content={node.content} animate={animate} budget={allowance} color={inheritedColor(parents, styles as Record<string, unknown>)} />;
        },
      }, merged, { onLinkPress });
      return <View key="markdown-root" style={merged.root as object}>{normalizeMarkdownKeys(nodes).map((node) => ast.renderNode(node, []))}</View>;
    };
  }, [animate, rules, style, onLinkPress]);
  return <Markdown renderer={renderer}>{source}</Markdown>;
}
