/**
 * Home, "Spotlight": a pool of the agent's colour behind a large Pew, an LED
 * status line, the greeting on one line in the dot-matrix face, a dim hint,
 * and a swipeable row of the agent's most recent chats.
 * Pew is decorative to assistive tech unless `onPressPew` makes it a button.
 */
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Reanimated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { theme } from "../theme";
import { lastActiveLabel } from "../ggState";
import { Dissolve } from "./motion/Dissolve";
import { OrcaMark } from "./OrcaMark";
import { pewInk } from "../pew/palette";
import { Led } from "./stage/Led";
import { PressScale } from "./stage/PressScale";
import { dashedOutline } from "./stage/DashedRule";
import { AgentGlow } from "./AgentGlow";

export interface HomeChat {
  id: string;
  title: string;
  startedAt: number;
}

export interface HomeGreetingProps {
  /** Kept for callers; the colour carries the agent's identity. */
  providerId?: string | undefined;
  /** The agent's brand colour; none is pew2's own coral. */
  color?: string;
  busy: boolean;
  /** The machine answered. Asleep otherwise. Defaults to online. */
  online?: boolean;
  /** Something nothing here can fix (a rotated key): Pew looks worried. */
  failed?: boolean;
  /** One line, dot-matrix. Omit to draw Pew alone. */
  text?: string;
  /** LED line under Pew, e.g. "READY · pew2 · 3 changed". */
  status?: string;
  /** Tapping Pew (the agent carousel). Shows the hint when set. */
  onPressPew?: () => void;
  /** Most recent first; the first six are shown. */
  chats?: readonly HomeChat[];
  onOpenChat?: (id: string) => void;
  /**
   * The keyboard's progress, 0 closed to 1 open. While you type the screen is
   * the sentence's: everything but Pew dissolves away, and Pew shrinks and
   * settles into the middle of what is left.
   */
  typing?: SharedValue<number>;
  /** Pew smiles (its tap is about to open the agent switcher, which carries the smile on). */
  smiling?: boolean;
}

/** Pew's size while typing, as a fraction of the hero. */
const TYPING_SCALE = 0.5;

/** Big enough to be the screen's subject, small enough to leave the greeting room. */
const HERO = 200;
const GLOW = 340;
const MAX_CHATS = 6;

export function HomeGreeting({ color, busy, online = true, failed = false, text, status, onPressPew, chats, onOpenChat, typing, smiling = false }: HomeGreetingProps) {
  const ink = pewInk(color);
  const shown = (chats ?? []).slice(0, MAX_CHATS);
  // Height of everything under Pew, so a typing Pew can move down by half of
  // it and sit in the middle of the block once the rest has gone.
  const below = useSharedValue(0);
  const still = useSharedValue(0);
  const k = typing ?? still;
  const pewStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: (below.value / 2) * k.value },
      { scale: 1 - (1 - TYPING_SCALE) * k.value },
    ],
  }));
  // Gone well before the keyboard lands, so nothing is caught mid-shrink.
  const restStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, 1 - k.value * 2.2),
  }));
  const [hidden, setHidden] = useState(false);
  // Whether the faded text still takes taps, flipped once the keyboard has
  // finished moving (a re-render mid-slide costs the frames the composer needs
  // to track it). In between, the text is already fading out of reach.
  useAnimatedReaction(
    () => (k.value >= 0.99 ? 1 : k.value <= 0.01 ? 0 : -1),
    (now, before) => {
      if (now !== -1 && now !== before) runOnJS(setHidden)(now === 1);
    },
  );
  return (
    <View style={styles.root}>
      <Reanimated.View style={[styles.spot, pewStyle]}>
        <AgentGlow color={ink} size={GLOW} />
        <Dissolve>
          {/* OrcaCoder: the Scarlet orca where pew2 draws Pew. It keeps Pew's
              job — tapping it opens the agent switcher — and breathes while an
              agent works. */}
          <Pressable
            disabled={!onPressPew}
            onPress={onPressPew}
            accessibilityRole={onPressPew ? "button" : undefined}
            accessibilityLabel={onPressPew ? "Switch agent" : undefined}
          >
            <OrcaMark size={HERO} busy={busy} />
          </Pressable>
        </Dissolve>
      </Reanimated.View>
      <Reanimated.View
        style={[styles.rest, restStyle]}
        pointerEvents={hidden ? "none" : "box-none"}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        onLayout={(e) => {
          below.value = e.nativeEvent.layout.height;
        }}
      >
      {status !== undefined && (
        <Led color={ink} style={styles.status}>
          {status}
        </Led>
      )}
      {/* The line's space is held whether or not there is a greeting yet, so
          it fades in where it will stay instead of nudging what is under it. */}
      <View style={styles.textHold}>
        {text !== undefined && (
          <Dissolve kind="swap" dissolveKey={text} delay={40} style={styles.textWrap}>
            <Text style={styles.text} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
              {text}
            </Text>
          </Dissolve>
        )}
      </View>
      {onPressPew && (
        <Text style={styles.hint} numberOfLines={1}>
          Tap the orca to switch agent
        </Text>
      )}
      {/* The row's height is held from the first frame, empty or not: the
          history arrives a moment after launch, and adding the row then pushed
          Pew and the greeting up the screen. Now the cards fade into a space
          that was already there. (A brand-new install with no chats keeps the
          empty band; the layout never jumps.) */}
      {onOpenChat && shown.length === 0 && <View style={styles.cardsHold} />}
      {shown.length > 0 && onOpenChat && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.cards}
          contentContainerStyle={styles.cardsRow}
          keyboardShouldPersistTaps="handled"
        >
          {shown.map((chat, i) => (
            <Dissolve key={chat.id} kind="row" delay={120 + i * 50}>
              <PressScale feel="tap" onPress={() => onOpenChat(chat.id)} style={styles.card}>
                <Led tone="dim" size={theme.stage.ledSize}>
                  {chat.startedAt > 0 ? lastActiveLabel(chat.startedAt) : "earlier"}
                </Led>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {chat.title}
                </Text>
              </PressScale>
            </Dissolve>
          ))}
        </ScrollView>
      )}
      </Reanimated.View>
    </View>
  );
}

/** The greeting's line height (theme.line.greeting), held before the greeting arrives. */
const GREETING_LINE = theme.line.greeting;

/** A recent-chat card's height, fixed so the row is the same before and after. */
const CARD_HEIGHT = 76;

const styles = StyleSheet.create({
  root: { alignItems: "center", justifyContent: "center", alignSelf: "stretch" },
  rest: { alignSelf: "stretch", alignItems: "center" },
  spot: { width: HERO, height: HERO, alignItems: "center", justifyContent: "center" },
  status: { marginTop: theme.space(1) },
  textHold: { alignSelf: "stretch", marginTop: theme.space(2), minHeight: GREETING_LINE },
  textWrap: { alignSelf: "stretch", paddingHorizontal: theme.gutter },
  text: {
    color: theme.color.text,
    fontFamily: theme.display.regular,
    fontSize: theme.font.greeting,
    lineHeight: theme.line.greeting,
    textAlign: "center",
  },
  hint: { color: theme.color.textDim, fontSize: 13, marginTop: theme.space(1) },
  cards: { alignSelf: "stretch", marginTop: theme.space(6), flexGrow: 0 },
  cardsRow: { paddingHorizontal: theme.gutter, gap: theme.space(2) },
  card: { ...dashedOutline, width: 148, height: CARD_HEIGHT, borderRadius: 12, padding: theme.space(3), gap: theme.space(1.5) },
  // The cards' space while there are none yet: the row's own height.
  cardsHold: { alignSelf: "stretch", marginTop: theme.space(6), height: CARD_HEIGHT },
  cardTitle: { color: theme.color.text, fontSize: 13, lineHeight: 17 },
});
