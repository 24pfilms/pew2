/**
 * The push drawer: how far it is uncovered, the spring that settles it, the
 * pane's slide, and the edge gestures that drag it in either direction.
 */
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { Keyboard } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { DRAWER_WIDTH } from "./Sidebar";

/**
 * How the drawer finishes a movement it was handed.
 *
 * Barely underdamped, unlike the sheets: the drawer stops against the screen
 * edge with a full conversation riding on it, and visible overshoot there reads
 * as the whole app sloshing rather than as a panel arriving.
 */
const DRAWER_SETTLE = { duration: 340, dampingRatio: 0.95 } as const;

/**
 * A flick worth committing to, in points per second.
 *
 * The same threshold the drawer has always used, restated in the units gesture
 * handler reports — it gives velocity per second where `PanResponder` gave it
 * per millisecond, so the old `0.4` is this.
 */
const FLICK = 400;

export function useDrawer({
  menuOpen,
  setMenuOpen,
  reduceMotion,
}: {
  menuOpen: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  reduceMotion: boolean;
}) {
  // How far the drawer is uncovered, 0 to 1.
  //
  // A shared value rather than an `Animated.Value`, and that is not a detail
  // here: this app streams an agent's output over a websocket while you use it,
  // so the JS thread is the one thing guaranteed to be busy. The drawer used to
  // be dragged from JS — a `PanResponder` calling `setValue` per touch event —
  // so it dropped frames exactly while a turn was arriving, which is exactly
  // when you reach for it. Nothing below re-renders as it moves.
  const drawer$ = useSharedValue(0);
  // How fast the finger was travelling when it let go, in drawer-widths per
  // second, handed to the spring that finishes the movement. Zero for every
  // other way in: a tap on the hamburger has no velocity to inherit.
  //
  // A plain ref rather than a shared value, because this is the one number that
  // genuinely has to cross threads. A shared value written from the gesture and
  // read back on the JS side syncs asynchronously — the settle would sometimes
  // read the previous gesture's velocity, or zero. Set through the same
  // `runOnJS` hop that dispatches the release, so it is always ordered before
  // the read.
  const fling = useRef(0);

  // Push, not overlay: the conversation slides right to uncover the drawer, so
  // both surfaces stay part of one layout instead of becoming a modal layer.
  // Shared with the edge gesture, which hands the drawer over mid-drag.
  //
  // A spring rather than the fixed 280ms curve this used to be, for the same
  // reason the sheets are springs: the drawer is most often released from a
  // finger, and a fixed curve throws away how fast that finger was moving. A
  // flick and a slow push now finish at the speeds they were given.
  const settleDrawer = useCallback(
    (open: boolean) => {
      // Consumed, not just read: every other route into this — the hamburger, a
      // session picked from the drawer, a cancelled gesture — must start from
      // rest rather than inherit the last flick's speed.
      const velocity = fling.current;
      fling.current = 0;
      drawer$.value = reduceMotion
        ? withTiming(open ? 1 : 0, { duration: 0 })
        : withSpring(open ? 1 : 0, { ...DRAWER_SETTLE, velocity });
    },
    [drawer$, reduceMotion],
  );

  /**
   * The finger let go. Runs on the JS thread, in one hop, so the velocity is
   * recorded before anything can read it.
   */
  const releaseDrawer = useCallback(
    (open: boolean, changed: boolean, velocity: number) => {
      fling.current = velocity;
      haptics.tap();
      // A state change re-runs the effect above, which settles. When the drawer
      // ends up where it started there is no change to react to, so settle here.
      if (changed) setMenuOpen(open);
      else settleDrawer(open);
    },
    // `setMenuOpen` is a state setter handed in from the screen: stable.
    [settleDrawer, setMenuOpen],
  );

  useEffect(() => {
    // The drawer is the full height of the screen and its conversations run to
    // the bottom edge, so opening it mid-sentence left the older ones behind the
    // keyboard. Leaving the conversation is exactly the moment the keyboard has
    // no claim on the screen — unlike the model pill, which keeps it on purpose.
    if (menuOpen) Keyboard.dismiss();
    settleDrawer(menuOpen);
  }, [menuOpen, settleDrawer]);

  // Translate only. The conversation keeps its exact size as it moves, so no
  // text reflows or resamples mid-animation.
  const paneSlide = useAnimatedStyle(() => ({
    transform: [{ translateX: drawer$.value * DRAWER_WIDTH }],
  }));

  /**
   * Hide the keyboard, from a worklet.
   *
   * A plain JS function so the gesture captures *this* and not the `Keyboard`
   * module: `runOnJS` still has to read its argument on the UI runtime, and a
   * native module is not serializable to it.
   */
  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  // The drawer tracks the finger in both directions: dragged out from the left
  // edge when closed, and pushed back by the uncovered pane when open. It is
  // being moved by the gesture rather than triggered by it.
  //
  // Rebuilt when `menuOpen` changes rather than read through a ref. A worklet
  // closes over its values when it is built, so the ref that kept the old
  // `PanResponder` honest is not just unnecessary here — reading `.current`
  // from the UI thread would not work at all.
  const buildEdgeSwipe = useCallback(() => {
    // Far enough to be deliberate, short enough not to feel like a tug of war.
    const reach = theme.space(2);
    return (
      Gesture.Pan()
        // The claim rules, now enforced natively before a single frame reaches
        // JS: only the direction that has somewhere to go, and abandoned the
        // moment the finger commits to the vertical. The old ratio test did the
        // same job from JS, one event late — which is how a fast scroll could
        // still start dragging the drawer before the test caught up.
        .activeOffsetX(menuOpen ? -reach : reach)
        .failOffsetY([-reach, reach])
        .onStart(() => {
          // Leaving the conversation, even a little: the drawer is a different
          // place, so the keyboard goes the moment the drag is claimed rather
          // than once it commits. Switching a model does not do this — that is
          // still the same conversation.
          //
          // `dismissKeyboard`, never `runOnJS(Keyboard.dismiss)`. This body is a
          // worklet, so naming `Keyboard.dismiss` reads a property off the
          // `Keyboard` module *on the UI runtime* — and a native module cannot
          // be sent there. Worklets throws, and a throw on the UI thread is not
          // catchable JS: it aborts the process. That is the whole crash — the
          // drawer never opened because the app died on the first frame of the
          // drag, in both directions, since both go through here.
          runOnJS(dismissKeyboard)();
          // The effect above animates this same value on `menuOpen`. Cancelling
          // here means the finger takes over from where the drawer currently
          // rests rather than from where it was heading.
          cancelAnimation(drawer$);
        })
        .onUpdate((event) => {
          const base = menuOpen ? 1 : 0;
          drawer$.value = Math.min(
            1,
            Math.max(0, base + event.translationX / DRAWER_WIDTH),
          );
        })
        .onEnd((event) => {
          // Signed against the one direction that has somewhere to go, so a drag
          // that is pulled back or flicked in reverse cancels rather than
          // committing on distance alone.
          const toward = menuOpen ? -event.translationX : event.translationX;
          const thrown = menuOpen ? -event.velocityX : event.velocityX;
          const commit = toward > DRAWER_WIDTH / 2 || thrown > FLICK;
          const open = commit ? !menuOpen : menuOpen;
          runOnJS(releaseDrawer)(
            open,
            open !== menuOpen,
            // Normalised to the same 0..1 scale the drawer moves on, or the
            // spring would be handed a number in points and leave immediately.
            event.velocityX / DRAWER_WIDTH,
          );
        })
        .onFinalize((_event, success) => {
          if (success) return;
          // Cancelled rather than released: a system gesture took the touch, or
          // the app lost it. Put the drawer back where it was instead of leaving
          // it stranded part way across. Skipped when it never actually moved,
          // which is every drag that failed the offset tests.
          if (drawer$.value === (menuOpen ? 1 : 0)) return;
          runOnJS(settleDrawer)(menuOpen);
        })
    );
  }, [menuOpen, drawer$, releaseDrawer, settleDrawer, dismissKeyboard]);

  // Two instances of the same gesture rather than one shared between the edge
  // strip and the overlay. A GestureDetector stamps its own handler tag onto the
  // object it is given, so handing the same one to two detectors leaves whichever
  // mounted last owning the tag — and since these two swap places every time the
  // drawer opens or closes, the loser is the one still on screen.
  const edgeSwipeClosed = useMemo(() => buildEdgeSwipe(), [buildEdgeSwipe]);
  const edgeSwipeOpen = useMemo(() => buildEdgeSwipe(), [buildEdgeSwipe]);
  // A third, on the drawer itself: full width, it covers the conversation, so
  // a left swipe anywhere on it is how it closes by hand.
  const drawerSwipe = useMemo(() => buildEdgeSwipe(), [buildEdgeSwipe]);

  // Belt and braces for every other way in: the hamburger, a swipe that the
  // strip lost, a session opened from the drawer. The drawer is never the place
  // to be typing into the conversation behind it.
  useEffect(() => {
    if (menuOpen) Keyboard.dismiss();
  }, [menuOpen]);

  return { paneSlide, edgeSwipeClosed, edgeSwipeOpen, drawerSwipe };
}
