/**
 * The OrcaZeroViva dashboard: a read-only summary of the computer's assistant.
 *
 * The snapshot is held in this component's state and nowhere else, so no PC
 * data is written to the phone. While the computer cannot be reached the last
 * snapshot stays up under "Last seen 14:02" until the app is closed.
 *
 * Asks on open, on pull, and every minute while visible and foregrounded.
 */
import { memo, useCallback, useEffect, useState } from "react";
import { Modal, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { wire } from "@pew2/protocol";
import { theme } from "../theme";
import {
  DASH_REFRESH_MS,
  DASH_TEXT,
  activityLabel,
  dueLabel,
  healthDots,
  lastSeenLabel,
  money,
  relativeTime,
  sectionView,
  spendPercent,
  spendTone,
  type SpendTone,
} from "../dashboard";
import { Glass } from "./Glass";
import { Skeleton } from "./Skeleton";
import { Led } from "./stage/Led";
import { StageScroll } from "./stage/StageScroll";
import { useAppActive } from "./useAppActive";

const LEVEL_COLOR: Record<wire.DashHealth["agentCore"], string> = {
  ok: theme.color.success,
  degraded: theme.color.attention,
  error: theme.color.danger,
};
const SPEND_COLOR: Record<SpendTone, string> = {
  ok: theme.color.success,
  attention: theme.color.attention,
  danger: theme.color.danger,
};

interface Props {
  visible: boolean;
  fetchDash: () => Promise<wire.Dash>;
  onClose: () => void;
}

function DashboardScreenView({ visible, fetchDash, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const appActive = useAppActive();
  const [snapshot, setSnapshot] = useState<wire.DashSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [pulled, setPulled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const reply = await fetchDash();
    setLoading(false);
    setPulled(false);
    if (reply.snapshot) {
      setSnapshot(reply.snapshot);
      setError(undefined);
    } else {
      setError(reply.error ?? DASH_TEXT.noReply);
    }
  }, [fetchDash]);

  useEffect(() => {
    if (!visible || !appActive) return;
    void load();
    const timer = setInterval(() => void load(), DASH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [visible, appActive, load]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top + theme.space(2), paddingLeft: insets.left + theme.gutter, paddingRight: insets.right + theme.gutter }]}>
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">Dashboard</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close dashboard" onPress={onClose} style={({ pressed }) => pressed && styles.pressed}>
            <Glass radius={theme.radius.pill} style={styles.close}>
              <Ionicons name="close" size={20} color={theme.color.glyph} />
            </Glass>
          </Pressable>
        </View>
        {error !== undefined && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {snapshot ? `${lastSeenLabel(snapshot.generatedAt)}. ${error}` : error}
          </Text>
        )}
        <StageScroll
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + theme.space(6) }]}
          refreshControl={
            <RefreshControl
              refreshing={pulled && loading}
              onRefresh={() => {
                setPulled(true);
                void load();
              }}
              tintColor={theme.color.textDim}
            />
          }
        >
          {snapshot ? <Sections snapshot={snapshot} /> : loading && <Placeholder />}
        </StageScroll>
      </View>
    </Modal>
  );
}

function Sections({ snapshot }: { snapshot: wire.DashSnapshot }) {
  const now = Date.now();
  return (
    <>
      <Section title="Today">
        <Spend cost={snapshot.cost} />
        <Health health={snapshot.health} />
      </Section>
      <Section title="Tasks">
        <Rows view={sectionView(snapshot.tasks, DASH_TEXT.noTasks)} render={(task) => <Row key={task.id} main={task.title} side={dueLabel(task.dueDate)} />} />
      </Section>
      <Section title="Routines">
        <Rows
          view={sectionView(snapshot.routines, DASH_TEXT.noRoutines)}
          render={(routine) => (
            <Row
              key={routine.id}
              main={routine.name}
              side={routine.enabled ? (routine.nextRunAt ? relativeTime(routine.nextRunAt, now) : "On") : "Off"}
              dim={!routine.enabled}
            />
          )}
        />
      </Section>
      <Section title="Activity">
        <Rows
          view={sectionView(snapshot.activity, DASH_TEXT.noActivity)}
          render={(item, i) => <Row key={`${item.timestamp}:${i}`} main={activityLabel(item)} side={relativeTime(item.timestamp, now)} />}
        />
      </Section>
      <Section title="Recent chats">
        <Rows view={sectionView(snapshot.sessions, DASH_TEXT.noChats)} render={(chat) => <Row key={chat.id} main={chat.name} side={relativeTime(chat.updatedAt, now)} />} />
      </Section>
    </>
  );
}

function Spend({ cost }: { cost: wire.DashCost | null }) {
  if (!cost) return <Text style={styles.note}>{DASH_TEXT.unavailable}</Text>;
  const percent = spendPercent(cost.totalUsd, cost.dailyLimitUsd);
  const color = SPEND_COLOR[spendTone(percent, cost.alertAtPercent)];
  const label = cost.dailyLimitUsd === null ? `${money(cost.totalUsd)} · ${DASH_TEXT.noLimit}` : `${money(cost.totalUsd)} of ${money(cost.dailyLimitUsd)}`;
  return (
    <View style={styles.spend} accessible accessibilityLabel={`Spent today ${label}`}>
      <Row main="Spent today" side={label} />
      {percent !== undefined && (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${percent}%`, backgroundColor: color }]} />
        </View>
      )}
    </View>
  );
}

function Health({ health }: { health: wire.DashHealth | null }) {
  const dots = healthDots(health);
  if (!dots) return <Text style={styles.note}>{DASH_TEXT.unavailable}</Text>;
  return (
    <View style={styles.dots}>
      {dots.map((dot) => (
        <View key={dot.label} style={styles.dot} accessible accessibilityLabel={`${dot.label} ${dot.level}`}>
          <View style={[styles.led, { backgroundColor: LEVEL_COLOR[dot.level] }]} />
          <Text style={styles.dotLabel}>{dot.label}</Text>
        </View>
      ))}
    </View>
  );
}

function Rows<T>({ view, render }: { view: ReturnType<typeof sectionView<T>>; render: (row: T, index: number) => React.ReactNode }) {
  if (view.kind === "note") return <Text style={styles.note}>{view.text}</Text>;
  return <>{view.rows.map(render)}</>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Led tone="dim" size={10}>{title}</Led>
      {children}
    </View>
  );
}

function Row({ main, side, dim = false }: { main: string; side: string; dim?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.main, dim && styles.dimText]} numberOfLines={1}>{main}</Text>
      {side !== "" && <Text style={styles.side} numberOfLines={1}>{side}</Text>}
    </View>
  );
}

function Placeholder() {
  return (
    <View style={styles.section} accessibilityLabel="Loading dashboard">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} style={styles.skeleton} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: theme.space(3) },
  title: { color: theme.color.text, fontSize: theme.font.greeting, fontWeight: "600" },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
  error: { color: theme.color.attention, fontSize: theme.font.small, marginBottom: theme.space(3) },
  content: { gap: theme.space(6) },
  section: { gap: theme.space(3) },
  note: { color: theme.color.textDim, fontSize: theme.font.small },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(4) },
  main: { flexShrink: 1, color: theme.color.text, fontSize: theme.font.body },
  dimText: { color: theme.color.textDim },
  side: { color: theme.color.textDim, fontSize: theme.font.small },
  spend: { gap: theme.space(2) },
  track: { height: 6, borderRadius: 3, backgroundColor: theme.color.surfaceRaised, overflow: "hidden" },
  fill: { height: 6 },
  dots: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(4) },
  dot: { flexDirection: "row", alignItems: "center", gap: theme.space(1) },
  led: { width: 8, height: 8, borderRadius: 4 },
  dotLabel: { color: theme.color.textDim, fontSize: theme.font.small },
  skeleton: { height: 20, borderRadius: theme.radius.sm },
});

export const DashboardScreen = memo(DashboardScreenView);
