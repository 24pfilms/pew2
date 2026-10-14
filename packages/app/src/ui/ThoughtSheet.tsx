/**
 * An agent's thinking, on demand.
 *
 * Reasoning is context, not the answer: printed inline it doubles the length of
 * every turn and buries the reply the user actually came for. So the transcript
 * shows one quiet "Thought process" row and the text lives here, in the same
 * card the command picker uses — same height, same chrome — scrolled rather
 * than truncated, because a thought worth opening is worth reading in full.
 */
import { memo, useRef } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import { MarkdownText } from "./MarkdownText";
import { theme } from "../theme";
import { Sheet } from "./Sheet";

interface ThoughtSheetProps {
  visible: boolean;
  text: string;
  onClose: () => void;
}

function ThoughtSheetView({ visible, text, onClose }: ThoughtSheetProps) {
  const { height: screenHeight } = useWindowDimensions();
  // The closed state carries no text, so the card would empty on the first
  // frame of the exit and the sheet would slide away blank. Keep the last
  // thought until another one replaces it.
  const held = useRef(text);
  if (text) held.current = text;

  return (
    <Sheet
      visible={visible}
      label="Thought"
      title="How it got there"
      onClose={onClose}
      dismissLabel="Close thought process"
    >
      <View>
        <StageScroll style={[styles.scroll, { maxHeight: Math.round(screenHeight * 0.6) }]} contentContainerStyle={styles.content}>
          {/* The dim thinking tone it had inline, so opening it does not promote
              reasoning to the same weight as the agent's answer. */}
          <MarkdownText text={held.current.trimEnd()} tone="thought" />
        </StageScroll>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Hugs the reasoning: a two-line thought opens a short sheet, not a tall
  // empty one. A long one stops at most of the screen and scrolls.
  scroll: { flexGrow: 0 },
  // Notes: no card, the reasoning sits quietly on the sheet itself.
  content: { paddingVertical: theme.space(2) },
});

export const ThoughtSheet = memo(ThoughtSheetView);
