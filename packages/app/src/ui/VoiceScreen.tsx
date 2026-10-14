/**
 * The live voice conversation, full screen.
 *
 * Built for a phone held at arm's length or in a pocket: one orb that says
 * what is happening, one line of status, the last few captions, and two big
 * buttons. Everything else stays on the conversation underneath.
 *
 * It also shrinks: the minimise button (and Android's back) drops the call to
 * the VoiceBar banner so the agent's work can be watched in the chat without
 * hanging up. The call itself lives in `useVoice`, not in this screen, so
 * closing this view never touches the audio.
 */
import { memo } from "react";
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { OrcaMark } from "./OrcaMark";
import { Glass } from "./Glass";
import type { Voice } from "./useVoice";

const VISIBLE_CAPTIONS = 4;

function VoiceScreenView({ voice, color }: { voice: Voice; color?: string }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const orbSize = Math.round(Math.min(width, height) * (landscape ? 0.32 : 0.42));
  const { state, orb } = voice;
  const failed = state.phase === "error";
  const captions = state.captions.slice(-VISIBLE_CAPTIONS);
  const speaking = orb === "speaking";

  return (
    <Modal visible={voice.open} animationType="fade" onRequestClose={failed ? voice.dismiss : voice.minimize} statusBarTranslucent supportedOrientations={["portrait", "landscape"]}>
      <View
        style={[
          styles.screen,
          landscape && styles.landscape,
          { paddingTop: insets.top + theme.space(4), paddingBottom: insets.bottom + theme.space(4), paddingLeft: insets.left + theme.gutter, paddingRight: insets.right + theme.gutter },
        ]}
      >
        {!failed && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Minimise and keep talking"
            onPress={voice.minimize}
            style={({ pressed }) => [styles.minimize, { top: insets.top + theme.space(2), left: insets.left + theme.gutter }, pressed && styles.pressed]}
          >
            <Glass radius={theme.radius.pill} style={styles.minimizeButton}>
              <Ionicons name="chevron-down" size={22} color={theme.color.glyph} />
            </Glass>
          </Pressable>
        )}
        <View style={styles.stage}>
          <View style={[styles.orb, speaking && styles.speaking]}>
            <OrcaMark size={orbSize} busy={orb === "connecting" || orb === "working" || speaking} />
          </View>
          <Text style={[styles.status, failed && styles.error]} accessibilityLiveRegion="polite" numberOfLines={3}>
            {voice.statusLine}
          </Text>
          {/* Deliberately small and dim: informative if looked for, invisible
              to a conversation. */}
          {voice.usageLine !== "" && <Text style={styles.usage}>{voice.usageLine}</Text>}
        </View>
        <View style={styles.side}>
          <View style={styles.captions} accessibilityLabel="Conversation captions">
            {captions.map((caption) => (
              <Text key={caption.id} numberOfLines={3} style={[styles.caption, caption.speaker === "user" ? styles.user : styles.assistant]}>
                {caption.text}
              </Text>
            ))}
          </View>
          <View style={styles.controls}>
            {!failed && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={state.muted ? "Unmute microphone" : "Mute microphone"}
                accessibilityState={{ selected: state.muted, disabled: state.phase !== "live" }}
                disabled={state.phase !== "live"}
                onPress={voice.toggleMute}
                style={({ pressed }) => [pressed && styles.pressed, state.phase !== "live" && styles.disabled]}
              >
                <Glass radius={theme.radius.pill} style={[styles.button, state.muted && styles.muted]}>
                  <Ionicons name={state.muted ? "mic-off" : "mic"} size={28} color={state.muted ? theme.color.bg : theme.color.glyph} />
                </Glass>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={failed ? "Close" : "End voice conversation"}
              disabled={state.phase === "ending"}
              onPress={failed ? voice.dismiss : voice.end}
              style={({ pressed }) => [styles.button, styles.end, pressed && styles.pressed]}
            >
              <Ionicons name={failed ? "close" : "call"} size={28} color={theme.color.text} style={failed ? undefined : styles.hangup} />
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const BUTTON = 72;
const MINIMIZE = 40;
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg, justifyContent: "space-between" },
  landscape: { flexDirection: "row", alignItems: "center", gap: theme.space(8) },
  minimize: { position: "absolute", zIndex: 2 },
  minimizeButton: { width: MINIMIZE, height: MINIMIZE, borderRadius: MINIMIZE / 2, alignItems: "center", justifyContent: "center" },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space(6) },
  side: { gap: theme.space(6), flexShrink: 1, minWidth: 0 },
  orb: { opacity: 0.85 },
  speaking: { opacity: 1, transform: [{ scale: 1.06 }] },
  status: { color: theme.color.text, fontSize: theme.font.title, textAlign: "center" },
  usage: { color: theme.color.textDim, fontSize: theme.font.small, textAlign: "center" },
  error: { color: theme.color.danger },
  captions: { gap: theme.space(2), minHeight: theme.line.body * 3 },
  caption: { fontSize: theme.font.body, lineHeight: theme.line.body },
  user: { color: theme.color.textDim, textAlign: "right" },
  assistant: { color: theme.color.text },
  controls: { flexDirection: "row", justifyContent: "center", gap: theme.space(10) },
  button: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: "center", justifyContent: "center" },
  muted: { backgroundColor: theme.color.text },
  end: { backgroundColor: theme.color.danger },
  hangup: { transform: [{ rotate: "135deg" }] },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.4 },
});

export const VoiceScreen = memo(VoiceScreenView);
