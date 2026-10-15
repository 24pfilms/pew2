/**
 * One Orca page on the phone: a read-only list of titles and dates.
 *
 * Held in this component's state only, like the dashboard itself, so nothing
 * from the computer is written to the phone. Asks on open and on pull.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { wire } from "@pew2/protocol";
import { theme } from "../theme";
import { DASH_PAGES, DASH_TEXT, lastSeenLabel, pageOutcome, whenLabel } from "../dashboard";
import { Glass } from "./Glass";
import { Skeleton } from "./Skeleton";
import { StageScroll } from "./stage/StageScroll";

interface Props {
  view: wire.DashViewName | undefined;
  fetchDash: (view?: wire.DashViewName) => Promise<wire.Dash>;
  onClose: () => void;
}

function DashboardPageView({ view, fetchDash, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<{ view: wire.DashViewName; rows: wire.DashViewItem[]; generatedAt: number }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  // Only the newest request may touch state: a slow reply for a page already left is dropped.
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!view) {
      latest.current++;
      return;
    }
    const mine = ++latest.current;
    setLoading(true);
    const outcome = pageOutcome(await fetchDash(view), view);
    if (mine !== latest.current) return;
    setLoading(false);
    if (outcome.kind === "items") {
      setItems({ view, rows: outcome.items, generatedAt: outcome.generatedAt });
      setError(undefined);
    } else {
      setError(outcome.text);
    }
  }, [view, fetchDash]);

  // A different page never shows the previous page's rows while it loads.
  useEffect(() => {
    setItems(undefined);
    setError(undefined);
    void load();
  }, [load]);

  const label = DASH_PAGES.find((page) => page.view === view)?.label ?? "";
  const shown = items && items.view === view ? items : undefined;
  const now = Date.now();

  return (
    <Modal visible={view !== undefined} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top + theme.space(2), paddingLeft: insets.left + theme.gutter, paddingRight: insets.right + theme.gutter }]}>
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">{label}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Close ${label}`} onPress={onClose} style={({ pressed }) => pressed && styles.pressed}>
            <Glass radius={theme.radius.pill} style={styles.close}>
              <Ionicons name="close" size={20} color={theme.color.glyph} />
            </Glass>
          </Pressable>
        </View>
        {error !== undefined && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {shown ? `${lastSeenLabel(shown.generatedAt)}. ${error}` : error}
          </Text>
        )}
        <StageScroll
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + theme.space(6) }]}
          refreshControl={<RefreshControl refreshing={loading && shown !== undefined} onRefresh={() => void load()} tintColor={theme.color.textDim} />}
        >
          {shown ? (
            shown.rows.length === 0 ? (
              <Text style={styles.note}>{DASH_TEXT.noItems}</Text>
            ) : (
              shown.rows.map((row) => (
                <View key={row.id} style={styles.row} accessible accessibilityLabel={[row.title, row.detail, row.at && whenLabel(row.at, now)].filter(Boolean).join(", ")}>
                  <View style={styles.text}>
                    <Text style={styles.main} numberOfLines={2}>{row.title}</Text>
                    {row.detail !== undefined && <Text style={styles.side} numberOfLines={1}>{row.detail}</Text>}
                  </View>
                  {row.at !== undefined && <Text style={styles.side}>{whenLabel(row.at, now)}</Text>}
                </View>
              ))
            )
          ) : (
            loading && [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} style={styles.skeleton} />)
          )}
        </StageScroll>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: theme.space(3) },
  title: { color: theme.color.text, fontSize: theme.font.greeting, fontWeight: "600" },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
  error: { color: theme.color.attention, fontSize: theme.font.small, marginBottom: theme.space(3) },
  content: { gap: theme.space(4) },
  note: { color: theme.color.textDim, fontSize: theme.font.small },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(4) },
  text: { flexShrink: 1, gap: theme.space(1) },
  main: { color: theme.color.text, fontSize: theme.font.body },
  side: { color: theme.color.textDim, fontSize: theme.font.small },
  skeleton: { height: 20, borderRadius: theme.radius.sm },
});

export const DashboardPage = memo(DashboardPageView);
