/** Styles for the main screen's shell: pane, nav, greeting, dock. */
import { StyleSheet } from "react-native";
import { theme } from "./theme";

export const styles = StyleSheet.create({
  // The drawer paints its own panel. Matching the conversation canvas here
  // removes the stray drawer-coloured band beneath the closed pane/home area.
  root: { flex: 1, backgroundColor: theme.color.bg },
  // Rounded on all corners: once it slides it is a card over the drawer, and
  // the curve is what makes the two planes legible.
  pane: {
    flex: 1,
    backgroundColor: theme.color.bg,
    borderRadius: theme.radius.pane,
    overflow: "hidden",
    // Must sit above the drawer, which is absolutely positioned and would
    // otherwise paint over this pane and swallow its touches.
    zIndex: 1,
    // A cast shadow is what stops the two dark planes merging into one at the
    // seam once the pane slides clear.
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: -8, height: 0 },
    elevation: 16,
  },
  paneInner: { flex: 1 },
  body: { flex: 1 },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    // Shares theme.gutter and theme.headerInset with the drawer header, so the
    // hamburger and the "Connected Apps" title it reveals sit on one rail and
    // one baseline.
    paddingHorizontal: theme.gutter,
    paddingVertical: theme.headerInset,
  },
  topBarOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 3,
  },
  navFade: { zIndex: 2 },
  navAction: { width: theme.size.control, flexShrink: 0 },
  // Two controls on the right in a goal; the menu side takes the same width so
  // the title stays centred on the screen.
  navLeadGoal: { justifyContent: "flex-start" },
  navActionsGoal: {
    width: theme.size.control * 2 + theme.space(2),
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.space(2),
    flexShrink: 0,
  },
  sessionTitle: {
    textAlign: "center",
    flex: 1,
    minWidth: 0,
    color: theme.color.text,
    fontSize: theme.font.body,
    fontWeight: "600",
  },

  statusDot: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: theme.color.bg,
  },


  greetingLift: { flex: 1 },
  // Full width: HomeGreeting puts its own text on the gutter, and its row of
  // recent chats has to scroll edge to edge while starting on that same rail.
  greeting: {
    flex: 1,
    alignItems: "stretch",
    justifyContent: "center",
    gap: theme.space(5),
  },
  greetingText: {
    color: theme.color.text,
    fontFamily: theme.display.regular,
    fontSize: theme.font.greeting,
    lineHeight: theme.line.greeting,
    letterSpacing: 0.3,
    textAlign: "center",
  },

  // One consistent gap between the thread and the composer, kept when the
  // keyboard is open so the last message never hides behind the input.
  dock: {
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(2),
  },
  dockOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 3,
  },
  // Behind the composer, filling the wrapper it shares with it.
  dockCover: { zIndex: 0 },

  // Rides above the composer it belongs to, at the gutter it shares with the
  // thread, so it lands over the conversation rather than over the input.

  jumpToEnd: {
    position: "absolute",
    right: theme.gutter,
    bottom: "100%",
    marginBottom: theme.space(2),
    zIndex: 1,
    // Opaque disc behind the glass. Every other glass control sits over the
    // dock's blur; this one floats on the bare transcript, so without a fill
    // the words it covers read straight through the arrow.
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.size.chip / 2,
  },

  // A narrow strip: wide enough to catch a deliberate edge swipe, too narrow to
  // interfere with anything the conversation itself does.
  edgeSwipe: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: theme.space(5),
    zIndex: 4,
  },
});
