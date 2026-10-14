/**
 * The voice conversation, shrunk to a banner.
 *
 * Shown while a call is live but the full VoiceScreen is minimised, so the
 * user can watch the agent's work in the chat without hanging up. The body
 * taps back up to the full screen; mute and end are reachable without that
 * detour, because "stop listening" and "hang up" are the two things a person
 * wants *now*, not after a navigation.
 *
 * Errors never render here: the reducer forces the screen back up on failure,
 * so a banner state is always a healthy call.
 */
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { OrcaMark } from "./OrcaMark";
import { Glass } from "./Glass";
import type { Voice } from "./useVoice";

function VoiceBarView({ voice, color }: { voice: Voice; color?: string }) {
  const insets = useSafeAreaInsets();
  if (!voice.active || !voice.minimized) return null;
  const orb = voice.orb;
  const muted = voice.state.muted;
  return (
    <View
      style={[styles.wrap, { top: insets.top + theme.space(2), left: insets.left + theme.gutter, right: insets.right + theme.gutter }]}
      pointerEvents="box-none"
    >
      {/* Solid behind the glass: the fallback material is 90% transparent,
          fine over the static composer area but unreadable over a scrolling
          chat, which is exactly what this bar floats above. */}
      <Glass radius={theme.radius.pill} style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Return to the voice conversation"
          onPress={voice.expand}
          style={({ pressed }) => [styles.body, pressed && styles.pressed]}
        >
          <OrcaMark size={26} busy={orb === "connecting" || orb === "working" || orb === "speaking"} />
          <Text numberOfLines={1} style={styles.status}>
            {voice.statusLine}
          </Text>
          <Ionicons name="chevron-up" size={16} color={theme.color.textDim} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={muted ? "Unmute microphone" : "Mute microphone"}
          accessibilityState={{ selected: muted, disabled: voice.state.phase !== "live" }}
          disabled={voice.state.phase !== "live"}
          onPress={voice.toggleMute}
          style={({ pressed }) => [styles.button, pressed && styles.pressed, voice.state.phase !== "live" && styles.dimmed]}
        >
          <Ionicons name={muted ? "mic-off" : "mic"} size={20} color={muted ? theme.color.danger : theme.color.glyph} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End voice conversation"
          onPress={voice.end}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Ionicons name="call" size={20} color={theme.color.danger} style={styles.hangup} />
        </Pressable>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", zIndex: 10, alignItems: "center" },
  bar: { flexDirection: "row", alignItems: "center", maxWidth: 460, paddingLeft: theme.space(2), paddingRight: theme.space(1), backgroundColor: theme.color.bg },
  body: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.space(2), minWidth: 0, paddingVertical: theme.space(2) },
  status: { flex: 1, color: theme.color.text, fontSize: theme.font.body },
  button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  hangup: { transform: [{ rotate: "135deg" }] },
  pressed: { opacity: 0.65 },
  dimmed: { opacity: 0.4 },
});

export const VoiceBar = memo(VoiceBarView);

/**
 * A finished agent turn ringing the phone, as a banner in the same spot as
 * the minimised call. Accept starts a voice call briefed on that
 * conversation; decline (or two quiet minutes) dismisses it.
 */
function VoiceIncomingBarView({ voice }: { voice: Voice }) {
  const insets = useSafeAreaInsets();
  const incoming = voice.incoming;
  if (!incoming) return null;
  const who = incoming.agentName ?? "Your agent";
  const where = incoming.folder ? ` in ${incoming.folder}` : "";
  return (
    <View
      style={[styles.wrap, { top: insets.top + theme.space(2), left: insets.left + theme.gutter, right: insets.right + theme.gutter }]}
      pointerEvents="box-none"
    >
      <Glass radius={theme.radius.pill} style={styles.bar}>
        <View style={styles.body}>
          <Ionicons name="call" size={18} color={theme.color.accent} />
          <Text numberOfLines={1} style={styles.status} accessibilityLiveRegion="polite">
            {who} finished{where}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Answer and hear what happened"
          onPress={voice.acceptIncoming}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Ionicons name="call" size={20} color={theme.color.success} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          onPress={voice.declineIncoming}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Ionicons name="close" size={20} color={theme.color.danger} />
        </Pressable>
      </Glass>
    </View>
  );
}

export const VoiceIncomingBar = memo(VoiceIncomingBarView);
