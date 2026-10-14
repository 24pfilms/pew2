/**
 * The conversation transcript.
 *
 * A recycling list rather than a ScrollView, because the whole fold lives in
 * memory and re-parsing every markdown turn on each streamed chunk is what made
 * opening a session feel like a re-render.
 *
 * Scroll position is native business here, not ours. `maintainVisibleContentPosition`
 * is on by default in FlashList v2, so a row that grows mid-stream no longer
 * pushes the rows above it, and `startRenderingFromBottom` means the very first
 * painted frame is already at the newest message — no reveal, no catch-up scroll.
 */
import { createEntranceLifetime, type DissolveKind, type EntranceLifetime } from "../motion";
import { Dissolve } from "./motion/Dissolve";
import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Keyboard,
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { FlashList, type FlashListRef, type ListRenderItemInfo } from "@shopify/flash-list";
import { theme } from "../theme";
import { Turn } from "./Turn";
import { LedReceipt } from "./Ticker";
import { ConversationRestore, type ConversationRestoreProps } from "./ConversationRestore";
import { useStatusRowHeight } from "./useStatusRowHeight";
import { type TurnReceipt as Receipt } from "../activity";
import { retryTarget } from "../retryPrompt";
import type { Turn as TurnData } from "../useDaemon";
import { isEmptyTurn } from "../chunks";
import { streamIdentityKey, type LiveStreamIdentity } from "../smoothText";
import { loadEarlier, nextWindow, windowTurns, TRANSCRIPT_PAGE, type TranscriptWindow } from "../transcriptWindow";
import { Led } from "./stage/Led";
import { DashedRule } from "./stage/DashedRule";
import { haptics } from "./haptics";

/**
 * The thread's last row: the activity line / receipt plus the bottom reading
 * inset. A data row rather than `ListFooterComponent` — see `withFooter`.
 */
type FooterRow = { readonly id: typeof FOOTER_KEY; readonly footer: true };
/** The "load earlier" row at the top of a windowed transcript. */
type EarlierRow = { readonly id: typeof EARLIER_KEY; readonly earlier: true };
type ThreadRow = TurnData | FooterRow | EarlierRow;
const EARLIER_KEY = "__thread_earlier__";
const EARLIER_ROW: EarlierRow = { id: EARLIER_KEY, earlier: true };
const isEarlier = (row: ThreadRow): row is EarlierRow => (row as EarlierRow).earlier === true;

/** How many are hidden, and whether a page is landing, for the earlier row. */
const EarlierContext = createContext<{ count: number; lit: boolean; onPress: () => void }>({
  count: 0,
  lit: false,
  onPress: () => {},
});

/** Lit this long after a page lands, so the load reads as an event. */
const EARLIER_LIT_MS = 600;

function EarlierCell() {
  const { count, lit, onPress } = useContext(EarlierContext);
  const more = Math.min(count, TRANSCRIPT_PAGE);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={theme.space(2)}
      accessibilityRole="button"
      accessibilityLabel={`Load ${more} earlier messages, ${count} hidden`}
      style={styles.earlier}
    >
      <DashedRule style={styles.earlierRule} />
      <Led tone={lit ? "agent" : "dim"} unlit={!lit}>{`▲ EARLIER · ${count} MORE`}</Led>
      <DashedRule style={styles.earlierRule} />
    </Pressable>
  );
}
const FOOTER_KEY = "__thread_footer__";
const FOOTER_ROW: FooterRow = { id: FOOTER_KEY, footer: true };
const isFooter = (row: ThreadRow): row is FooterRow => (row as FooterRow).footer === true;

/** What the footer row shows, handed down by context so `renderItem` stays stable. */
const FooterContext = createContext<{ content: React.ReactNode; bottom: number }>({
  content: null,
  bottom: 0,
});

function FooterCell() {
  const { content, bottom } = useContext(FooterContext);
  return <View style={{ paddingBottom: bottom }}>{content}</View>;
}

export type ChatThreadRef = FlashListRef<ThreadRow>;

type Props = {
  turns: TurnData[];
  activeStream?: LiveStreamIdentity;
  restore?: ConversationRestoreProps;
  /** Clearance under the floating nav, before the first message. */
  threadTop: number;
  /** Clearance above the composer dock, after the last message. */
  threadBottom: number;
  /** The agent is mid-turn: show the streaming indicator below the transcript. */
  working: boolean;
  /** Ignored: the top bar's `Ticker` shows activity now. Kept so harnesses compile. */
  activity?: unknown;
  agentColor?: string;
  /** The turn that just ended, shown until the next prompt starts one. */
  receipt?: Receipt;
  /** Insets so the scroll indicator stays inside the unobscured reading area. */
  indicatorTop: number;
  indicatorBottom: number;
  onAtBottomChange: (atBottom: boolean) => void;
  /** Opens a thinking turn's full text. Must be stable: cells memo on it. */
  onOpenThought: (text: string) => void;
  /** Sends a failed prompt again. Must be stable: cells memo on it. */
  onRetry: (text: string) => void;
};

/** The entrance clock, read only from cells as they first render. */
const entranceClock = () => Date.now();

/** Long enough to cover DUR.restore; past it a key renders settled. */
const ENTRANCE_WINDOW_MS = 480;

function ChatThreadView(
  {
    turns,
    activeStream,
    restore,
    threadTop,
    threadBottom,
    working,
    receipt,
    indicatorTop,
    indicatorBottom,
    onAtBottomChange,
    onOpenThought,
    onRetry,
  }: Props,
  ref: React.Ref<ChatThreadRef>,
) {
  // Never while the agent is working: a turn in flight is not a turn that
  // failed, and the tail is a system line for as long as the next prompt takes
  // to produce anything.
  //
  // Decomposed to its two strings before `renderItem` closes over it, so the
  // cells are not re-rendered by a fresh object on every streamed chunk. Both
  // are undefined for the whole of an ordinary conversation.
  const retry = useMemo(() => (working ? undefined : retryTarget(turns)), [turns, working]);
  const retryKey = retry?.key;
  const retryPrompt = retry?.prompt;

  // Entrance gating: FlashList recycles cells, so a mount is not a new turn.
  // Each key's entrance is decided once: the first batch the thread sees (a
  // restore replacing the skeleton) dissolves together; later turns animate
  // only if newer than the high-water mark; everything else renders settled.
  const entrance = useRef<{ session: string | undefined; lifetime: EntranceLifetime; seen: Map<string, { kind: DissolveKind | null; at: number }> } | undefined>(undefined);
  const firstKey = turns[0] ? keyExtractor(turns[0]) : undefined;
  const session = firstKey?.slice(0, firstKey.lastIndexOf(":"));
  if (!entrance.current || entrance.current.session !== session) {
    const restoreBatch = turns.length;
    const lifetime = createEntranceLifetime(0);
    const seen = new Map<string, { kind: DissolveKind | null; at: number }>();
    turns.forEach((turn, i) => {
      lifetime.settle(i);
      // `at: -1`: the entrance window starts when the cell first asks (below),
      // which keeps the clock out of render.
      seen.set(keyExtractor(turn), { kind: restoreBatch > 0 ? "restore" : null, at: -1 });
    });
    entrance.current = { session, lifetime, seen };
  }
  const entranceFor = (key: string, index: number): DissolveKind | null => {
    const state = entrance.current;
    if (!state) return null;
    const known = state.seen.get(key);
    // Within the entrance window only: a recycled cell showing this key later,
    // or a re-render after it settled, must not replay it.
    if (known !== undefined) {
      if (known.at < 0) known.at = entranceClock();
      return entranceClock() - known.at < ENTRANCE_WINDOW_MS ? known.kind : null;
    }
    const kind: DissolveKind | null = state.lifetime.consume(index) ? "row" : null;
    state.seen.set(key, { kind, at: entranceClock() });
    return kind;
  };

  const [win, setWin] = useState<TranscriptWindow | undefined>(undefined);
  const settledWin = nextWindow(win, session, turns.length);
  // Persisted after commit so appends see the start this render used.
  useEffect(() => {
    if (settledWin !== win) setWin(settledWin);
  }, [settledWin, win]);
  const earlierOffset = Math.min(settledWin.start, turns.length);
  const earlierShown = earlierOffset > 0;

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<ThreadRow>) => {
      if (isFooter(item)) return <FooterCell />;
      if (isEarlier(item)) return <EarlierCell />;
      // An agent turn is committed empty and filled by later chunks. Rendering
      // its cell would reserve the gap below the reply before there is anything
      // in it, which the reader sees as the thread twitching.
      if (isEmptyTurn(item)) return null;
      const key = keyExtractor(item);
      // Entrance is decided against the whole conversation, not the window.
      const kind = entranceFor(key, index - (earlierShown ? 1 : 0) + earlierOffset);
      // Spacing and the side rails live on the cell: cells are positioned
      // individually, so a container `gap` would never apply, and horizontal
      // padding on the scroll content is not part of the list's layout math.
      return (
        <Dissolve kind={kind ?? "row"} enabled={kind !== null} dissolveKey={key} style={index === 0 ? styles.firstRow : styles.row}>
          <Turn
            turn={item}
            liveIdentity={activeStream?.turnKey === keyExtractor(item) && item.role === "agent" ? streamIdentityKey(activeStream) : undefined}
            onOpenThought={onOpenThought}
            retryPrompt={keyExtractor(item) === retryKey ? retryPrompt : undefined}
            onRetry={onRetry}
          />
        </Dissolve>
      );
    },
    [onOpenThought, onRetry, retryKey, retryPrompt, activeStream, earlierShown, earlierOffset],
  );

  // Mirrored into a ref so the inset effect below can read "is the reader at the
  // end" without re-running every time the answer changes.
  const atBottom = useRef(true);

  // Put the keyboard away the moment the transcript is dragged.
  //
  // `keyboardDismissMode` alone is not enough here. iOS's "interactive" never
  // fires at all: `useKeyboardLift` translates this pane to sit entirely above
  // the keyboard, so the finger never enters the frame that drives it. And
  // "on-drag" waits for the scroll to actually move content, which reads as the
  // keyboard hanging on for the first part of the gesture. `onScrollBeginDrag`
  // fires as soon as the pan is recognised, which is the "boom, gone" the
  // gesture should feel like.
  //
  // `dismiss()` blurs the composer, so this is the same state as tapping away
  // from the input rather than a second way of hiding the keyboard. It is a
  // no-op when nothing is focused, so an ordinary scroll costs nothing.
  const handleScrollBeginDrag = useCallback(() => {
    dragged.current = true;
    Keyboard.dismiss();
  }, []);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      // Exactly the threshold the list itself follows appends at, so the chip
      // means "the transcript has stopped following you" and nothing else. A
      // tighter slack put it on screen for every streamed chunk: the reply grows
      // a line, the end briefly sits beyond the viewport, and the chip appeared
      // while the list was already scrolling to catch up.
      const next =
        contentOffset.y + layoutMeasurement.height >=
        contentSize.height - layoutMeasurement.height * FOLLOW_THRESHOLD;
      atBottom.current = next;
      onAtBottomChange(next);
    },
    [onAtBottomChange],
  );

  // The reading-area insets are real rows, not `contentContainerStyle`.
  // FlashList v2 measures the scroll content itself, so padding on the content
  // container is not in that measurement: the transcript could be scrolled
  // under the composer and the last message sat behind it.
  //
  // The top inset is the header. The bottom inset (and the activity line above
  // it) is the LAST DATA ROW, not `ListFooterComponent`, because of how
  // `startRenderingFromBottom` bottom-aligns a short thread: it gives the item
  // container a top margin of `window - container - header`, and a list footer
  // sits outside that container, so its height is in nobody's sum. The content
  // was then always `window + footer` tall — a thread that fit the screen could
  // still be dragged by the footer's height, opening a band of blank canvas
  // above the first message with the last ones parked behind the composer.
  // Inside the container the margin accounts for it, a short thread is exactly
  // one screen tall, and `alwaysBounceVertical={false}` keeps it still.
  const headerStyle = useMemo(() => ({ height: threadTop }), [threadTop]);
  // No footer row for an empty thread: an empty list is what shows the restore
  // skeleton (`ListEmptyComponent`).
  //
  // Only the tail is mounted (`transcriptWindow.ts`); the rest waits behind the
  // earlier row. Prepending a page is absorbed by `maintainVisibleContentPosition`,
  // so the reader's place holds while it lands above them.
  const { visible, earlier } = useMemo(() => windowTurns(turns, settledWin), [turns, settledWin]);
  const rows = useMemo<ThreadRow[]>(
    () => (visible.length > 0 ? [...(earlier > 0 ? [EARLIER_ROW] : []), ...visible, FOOTER_ROW] : []),
    [visible, earlier],
  );

  // Whether the reader has dragged this thread themselves. Reaching the top
  // only pulls in older turns after that: while a long conversation lays out
  // it passes through the top on its own (before it settles at the bottom),
  // and treating that as "reached the top" loaded page after page and left
  // the thread parked mid-way instead of at the latest message.
  const dragged = useRef(false);
  useEffect(() => {
    dragged.current = false;
  }, [session]);
  const reachedTop = useCallback(() => {
    if (dragged.current) revealEarlierRef.current();
  }, []);
  const revealEarlierRef = useRef<() => void>(() => undefined);

  const [earlierLit, setEarlierLit] = useState(false);
  const revealEarlier = useCallback(() => {
    setWin(loadEarlier(settledWin));
    if (earlier > 0) {
      haptics.select();
      setEarlierLit(true);
    }
  }, [earlier, settledWin, setWin]);
  useEffect(() => {
    revealEarlierRef.current = revealEarlier;
  }, [revealEarlier]);
  useEffect(() => {
    if (!earlierLit) return;
    const timer = setTimeout(() => setEarlierLit(false), EARLIER_LIT_MS);
    return () => clearTimeout(timer);
  }, [earlierLit]);
  const earlierValue = useMemo(
    () => ({ count: earlier, lit: earlierLit, onPress: revealEarlier }),
    [earlier, earlierLit, revealEarlier],
  );

  // What the agent is doing lives in the top bar's ticker, never in the thread:
  // the footer is only the finished turn's LED receipt, or a spacer as tall as
  // it so the thread does not jump when a turn starts or ends.
  const footer = useMemo(
    () => (!working && receipt ? <LedReceipt receipt={receipt} /> : <SpacerOnly />),
    [receipt, working],
  );
  const footerValue = useMemo(() => ({ content: footer, bottom: threadBottom }), [footer, threadBottom]);

  // The composer grows when it takes focus, and the dock it lives in is an
  // overlay pinned to the bottom edge — so it expands *upwards*, over the
  // transcript. Growing the footer reserves the room but does not consume it:
  // the content below the viewport gets taller while the visible rows stay
  // exactly where they were, now behind the composer. Taking up the new slack
  // is what keeps the last message clear of it.
  const list = useRef<ChatThreadRef>(null);
  useImperativeHandle(ref, () => list.current as ChatThreadRef, []);

  // Only on the way *up*, and never animated.
  //
  // A shrinking dock gives empty space back below the last message: nothing was
  // hidden, so there is nothing to catch up to.
  //
  // Growth is the case that bites, because the dock also grows *as the keyboard
  // leaves* — `typing` goes false on `keyboardWillHide` and the context row
  // remounts into it. An animated `scrollToEnd` then runs its own curve across
  // the keyboard's dismissal, and two animations of different durations landing
  // at different times is the thread visibly re-seating itself. Unanimated, the
  // offset changes in the same frame as the layout that caused it, so it reads
  // as one motion. There is no lost information: the rows are already where the
  // reader left them and only the slack below moves.
  //
  // Only ever felt at the bottom of the thread, since that is the one place
  // this effect does anything at all.
  const lastBottom = useRef(threadBottom);
  useEffect(() => {
    const grew = threadBottom > lastBottom.current;
    lastBottom.current = threadBottom;
    if (!grew || !atBottom.current) return;
    list.current?.scrollToEnd({ animated: false });
  }, [threadBottom]);

  return (
    <EarlierContext.Provider value={earlierValue}>
    <FooterContext.Provider value={footerValue}>
    <FlashList
      ref={list}
      data={rows}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      // A user turn, an agent's markdown, a thought and a system line are four
      // different subtrees. Without this the list recycles any cell into any
      // other, so React reconciles two unrelated trees instead of updating one:
      // it tears the old subtree down and builds the new one — and under Fabric
      // that mount lands on the main thread, mid-scroll. Typed, a cell is only
      // ever reused for a turn of its own shape, which is the case
      // reconciliation is actually cheap for.
      getItemType={getItemType}
      // Follow an append only while the reader is near the end. Someone reading
      // history keeps their place while the reply streams on below.
      maintainVisibleContentPosition={MAINTAIN_POSITION}
      ListHeaderComponent={restore?.state === "failed" && turns.length > 0 ? <ConversationRestore {...restore} /> : SpacerOnly}
      ListEmptyComponent={restore ? <ConversationRestore {...restore} /> : null}
      ListHeaderComponentStyle={headerStyle}
      // Kept beside the explicit dismiss above as the native backstop: it needs
      // no JS, so a drag during a heavy streaming frame still puts the keyboard
      // away. Whichever fires first wins and the other is a no-op. Never iOS's
      // "interactive" — see `handleScrollBeginDrag`.
      keyboardDismissMode="on-drag"
      onScrollBeginDrag={handleScrollBeginDrag}
      keyboardShouldPersistTaps="handled"
      // The transcript gives at both ends, and springs back.
      //
      // It used to stop dead. The reason was real but narrower than the fix:
      // this list's reading insets are real children, and a *short* thread is
      // bottom-aligned by `startRenderingFromBottom`, so a downward drag there
      // slid the newest message under the composer — the one place the inset is
      // load-bearing, undone by a gesture, looking like a layout fault rather
      // than a stretch. Killing the bounce outright also took the give away
      // from every scrollable transcript, where the end of a conversation
      // arrived like a wall and nothing distinguished "the top of the history"
      // from "the list is stuck".
      //
      // `alwaysBounceVertical` is the seam between those two cases: a thread
      // that does not fill the screen cannot be dragged at all, so the inset it
      // depends on stays intact, while a thread long enough to scroll bounces
      // at both ends like every other list on the platform. Nothing is under
      // the composer to expose there — the content that moves is mid-thread,
      // which already passes under the translucent dock while scrolling.
      bounces
      alwaysBounceVertical={false}
      // Android's equivalent, and the same bargain: on 12+ this is the stretch
      // — a spring driven by the platform, not by us — and a glow below that.
      // "never" was the pair of `bounces={false}` and would otherwise leave the
      // two platforms feeling different at the same edge.
      overScrollMode="auto"
      automaticallyAdjustsScrollIndicatorInsets={false}
      // The whole pane is lifted by one transform instead (see `useKeyboardLift`).
      // UIKit's own keyboard inset would be a second, differently-timed
      // adjustment on top of it. Both props are iOS-only and inert on Android,
      // where the library holds the window at a fixed size for the same reason.
      automaticallyAdjustKeyboardInsets={false}
      automaticallyAdjustContentInsets={false}
      scrollIndicatorInsets={{ top: indicatorTop, bottom: indicatorBottom }}
      scrollEventThrottle={16}
      onScroll={handleScroll}
      // Reaching the top pulls the next page in, same as tapping the row.
      onStartReached={earlier > 0 ? reachedTop : undefined}
      onStartReachedThreshold={0.2}
    />
    </FooterContext.Provider>
    </EarlierContext.Provider>
  );
}

/**
 * How near the end counts as following the conversation, as a fraction of the
 * viewport. Shared by the list's autoscroll and the jump-to-latest chip so the
 * two can never disagree about whether you are at the bottom.
 */
const FOLLOW_THRESHOLD = 0.2;

const MAINTAIN_POSITION = {
  startRenderingFromBottom: true,
  autoscrollToBottomThreshold: FOLLOW_THRESHOLD,
  // Same reasoning as the `threadBottom` catch-up above, for the same reason.
  //
  // FlashList animates this by default, which suits a chat where a whole
  // message arrives at once. A streamed reply is not that: the last row grows
  // by a fraction of a line many times a second, and each growth starts its own
  // curve over the one still running. The text then trails the bottom edge and
  // settles a beat after it stops — motion that carries nothing, since the
  // reader is already at the end and only the slack below is moving. Unanimated,
  // the offset changes in the frame the line was added, so the reply simply
  // grows downward.
  animateAutoScrollToBottom: false,
} as const;

// `key` where the turn has one: an optimistic prompt's `id` is replaced by the
// server's when the echo lands, and keying on that would recycle the cell out
// from under a message that never changed.
const keyExtractor = (row: ThreadRow) => (isFooter(row) ? FOOTER_KEY : isEarlier(row) ? EARLIER_KEY : (row.key ?? row.id));

/** One recycling pool per shape of turn. Reasoning at the call site. */
const getItemType = (row: ThreadRow) => (isFooter(row) ? "footer" : isEarlier(row) ? "earlier" : row.role);

/** Carries only a `ListHeaderComponentStyle`/`ListFooterComponentStyle` inset. */
/**
 * The idle footer: nothing to see, but exactly as tall as the busy one.
 *
 * `ActivityLine` and `TurnReceipt` occupy one body line plus the
 * gap above it. This rendered nothing, so the moment an agent started thinking
 * the transcript jumped by that height — visible on every first prompt as the
 * message sliding upward just before the reply began.
 *
 * All three read that line from `useStatusRowHeight`, because at a large Dynamic
 * Type setting a body line is not `theme.line.body` — see `statusRow.ts`.
 *
 * Only the first turn showed it: after that the list is long enough to be
 * scrolled rather than bottom-aligned, so the growth goes below the fold where
 * nobody sees it.
 */
const SpacerOnly = () => (
  <View style={[styles.footerSpacer, { height: useStatusRowHeight() }]} />
);

const styles = StyleSheet.create({
  row: { paddingTop: theme.space(5), paddingHorizontal: theme.gutter },
  firstRow: { paddingTop: 0, paddingHorizontal: theme.gutter },
  // Same reserved height and top gap as ActivityLine and TurnReceipt.
  earlier: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingHorizontal: theme.gutter,
    paddingBottom: theme.space(1),
  },
  earlierRule: { flex: 1 },
  footerSpacer: {
    marginTop: theme.space(5),
  },
});

export const ChatThread = memo(forwardRef<ChatThreadRef, Props>(ChatThreadView));
