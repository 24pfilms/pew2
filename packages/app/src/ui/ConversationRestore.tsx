/**
 * Reopening a conversation — Stage "Rewind".
 *
 * Fast restores must not flash: the loading state renders nothing for its
 * first GRACE_MS, then a thinking Pew, an LED "Reopening" and a few ghost rows.
 * The moment content lands the parent stops rendering this — no minimum time.
 * Failure: Pew oops, an attention LED, the reason, and Try again.
 */
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { Pew } from "../pew/Pew";
import { Led } from "./stage/Led";
import { StageButton } from "./stage/StageButton";
import { useAgentColor } from "./stage/agentColor";
import { Dissolve } from "./motion/Dissolve";
import type { RestorePresentation } from "../restoreState";

const GRACE_MS = 250;

export interface ConversationRestoreProps {
  title: string;
  state: RestorePresentation;
  error?: string;
  onRetry: () => void;
}

export function ConversationRestore({ title, state, error, onRetry }: ConversationRestoreProps) {
  const agent = useAgentColor();
  const waiting = state === "loading" || state === "reconnecting";
  const [graced, setGraced] = useState(false);

  useEffect(() => {
    if (!waiting) {
      setGraced(false);
      return;
    }
    const timer = setTimeout(() => setGraced(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  useEffect(() => {
    if (state === "failed") haptics.failed();
  }, [state]);

  if (!state) return null;
  if (waiting && !graced) return null;

  if (state === "failed") {
    return (
      <View style={styles.root}>
        <View style={styles.head}>
          <Pew size={44} mood="oops" color={agent} style={styles.pew} />
          <Led tone="attention">Couldn&apos;t reopen it</Led>
        </View>
        <Text style={styles.message} numberOfLines={2} accessibilityRole="alert">
          {error ?? "This conversation could not be opened."}
        </Text>
        <StageButton
          label="Try again"
          accessibilityLabel={`Try opening ${title} again`}
          style={styles.retry}
          onPress={onRetry}
        />
      </View>
    );
  }

  if (state === "empty") {
    return (
      <View style={styles.root}>
        <View style={styles.head}>
          <Pew size={44} mood="sleepy" color={agent} style={styles.pew} />
          <Led tone="dim">No messages yet</Led>
        </View>
      </View>
    );
  }

  // One thing on screen while it loads: Pew, centred, and what it's doing.
  // The ticker and the messages arrive together once there's something to
  // show, rather than a strip and skeleton rows in different alignments first.
  return (
    <View style={styles.loading} accessibilityLabel={`Reopening ${title}`}>
      <Dissolve kind="in">
        <View style={styles.loadingInner}>
          <Pew size={96} mood="thinking" color={agent} />
          <Led>{state === "reconnecting" ? "Reconnecting" : "Reopening"}</Led>
        </View>
      </Dissolve>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: theme.gutter, paddingVertical: theme.sectionGap, gap: theme.space(3) },
  head: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  // The globe fills ~60% of its box; trim the box so the row stays tight.
  pew: { margin: -theme.space(2) },
  message: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 20 },
  loading: { flex: 1, minHeight: 360, alignItems: "center", justifyContent: "center" },
  loadingInner: { alignItems: "center", gap: theme.space(1) },
  retry: { alignSelf: "center" },
});
