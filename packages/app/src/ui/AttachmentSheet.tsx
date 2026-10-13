/**
 * Where an attachment comes from: library, camera, or files.
 *
 * A sheet rather than an action popover for the same reason as `CommandSheet`:
 * it arrives from the edge the thumb is already at, and picking a source is a
 * deliberate choice rather than a menu to skim. The chrome is the shared
 * `Sheet`, so this reads as the same object as the command and approval sheets.
 *
 * The three sources are listed even when one will fail: a phone with camera
 * access denied still shows "Take Photo", and refusing at that point is what
 * produces a message naming Settings. Hiding the row instead would leave the
 * user with a missing feature and no explanation.
 */
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { Sheet } from "./Sheet";
import { PressScale } from "./stage/PressScale";
import { Led } from "./stage/Led";
import { dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { Dissolve } from "./motion/Dissolve";

export type AttachmentSource = "library" | "camera" | "files";

interface AttachmentSheetProps {
  visible: boolean;
  onSelect: (source: AttachmentSource) => void;
  onClose: () => void;
}

const SOURCES: {
  id: AttachmentSource;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
}[] = [
  { id: "camera", icon: "camera-outline", label: "Camera", hint: "Take a photo" },
  { id: "library", icon: "images-outline", label: "Photos", hint: "Screenshots and photos" },
  { id: "files", icon: "document-outline", label: "Files", hint: "Logs, diffs, anything else" },
];

function AttachmentSheetView({ visible, onSelect, onClose }: AttachmentSheetProps) {
  const agent = useAgentColor();
  return (
    <Sheet visible={visible} label="Attach" title="Add to the message" onClose={onClose} dismissLabel="Close attachments">
      <View style={styles.tiles}>
        {SOURCES.map((source, index) => (
          <Dissolve key={source.id} kind="row" delay={visible ? index * 50 : 0} dissolveKey={String(visible)} style={styles.cell}>
            <PressScale
              feel="tap"
              style={styles.tile}
              accessibilityLabel={`${source.label}. ${source.hint}`}
              onPress={() => onSelect(source.id)}
            >
              {/* The glyph glows in the agent colour, like an LED. */}
              <Ionicons
                name={source.icon}
                size={26}
                color={agent}
                style={{ textShadowColor: agent, textShadowRadius: 8, textShadowOffset: { width: 0, height: 0 } }}
              />
              <Led tone="text" size={11} unlit numberOfLines={1}>
                {source.label}
              </Led>
            </PressScale>
          </Dissolve>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", gap: theme.space(3) },
  cell: { flex: 1 },
  tile: {
    ...dashedOutline,
    borderRadius: theme.space(3),
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(3),
  },
});

export const AttachmentSheet = memo(AttachmentSheetView);
