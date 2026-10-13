/**
 * The switches for staying connected and ringing, and the phone settings they
 * depend on.
 *
 * The settings part exists because Android phones — OPPO's ColorOS above all —
 * close background apps unless told not to, and no app can change that for
 * itself. Each row says whether it is done and opens the right settings page if
 * not. "Auto launch" has no way to be read back, so it only offers the page.
 */
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import * as PewLink from "../../modules/pew-link";
import type { LinkSettings } from "../linkSettings";
import { haptics } from "./haptics";
import { theme } from "../theme";

export function PhoneSetup({
  visible,
  settings,
  onChange,
}: {
  visible: boolean;
  settings: LinkSettings;
  onChange: (next: LinkSettings) => void;
}) {
  const [battery, setBattery] = useState(true);
  const [fullScreen, setFullScreen] = useState(true);
  const refresh = useCallback(() => {
    setBattery(PewLink.batteryUnrestricted());
    setFullScreen(PewLink.canRingFullScreen());
  }, []);

  // Re-read on open and on coming back from a settings page, which is where the
  // user just changed it.
  useEffect(() => {
    if (!visible) return;
    refresh();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });
    return () => subscription.remove();
  }, [visible, refresh]);

  if (!PewLink.available) return null;
  const set = (key: keyof LinkSettings) => (value: boolean) => {
    haptics.tap();
    onChange({ ...settings, [key]: value });
  };

  return (
    <View style={styles.group}>
      <Text style={styles.heading}>Away from the app</Text>
      <Toggle
        label="Stay connected in the background"
        detail="Keeps a quiet notification while pew2 is connected."
        value={settings.background}
        onChange={set("background")}
      />
      <Toggle
        label="Ring when an agent needs approval"
        value={settings.ringApprovals}
        onChange={set("ringApprovals")}
      />
      <Toggle
        label="Ring when an agent finishes"
        value={settings.ringFinished}
        onChange={set("ringFinished")}
      />

      <Text style={styles.heading}>Phone setup</Text>
      <Check
        label="Battery: unrestricted"
        done={battery}
        action="Allow"
        onPress={() => {
          // The direct prompt where it exists; OPPO also needs "Allow background
          // activity" on the app's own page, so that opens afterwards.
          if (!PewLink.requestBatteryUnrestricted()) PewLink.openAppSettings();
        }}
      />
      <Check label="Auto launch" action="Open" onPress={() => PewLink.openAutoStart()} />
      <Check
        label="Full-screen ringing"
        done={fullScreen}
        action="Allow"
        onPress={() => PewLink.openFullScreenSettings()}
      />
      <Pressable accessibilityRole="button" style={styles.link} onPress={() => PewLink.openAppSettings()}>
        <Text style={styles.linkText}>Open pew2's Android settings</Text>
      </Pressable>
    </View>
  );
}

function Toggle({
  label,
  detail,
  value,
  onChange,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.label}>{label}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: theme.color.accent, false: theme.color.surfaceRaised }}
      />
    </View>
  );
}

function Check({
  label,
  done,
  action,
  onPress,
}: {
  label: string;
  /** Undefined when the phone cannot report it. */
  done?: boolean;
  action: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>
        {done === undefined ? "" : done ? "✓ " : "✗ "}
        {label}
      </Text>
      {done ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action}: ${label}`}
          style={styles.button}
          onPress={() => {
            haptics.tap();
            onPress();
          }}
        >
          <Text style={styles.buttonText}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: theme.space(2) },
  heading: { color: theme.color.textDim, fontSize: theme.font.small, marginTop: theme.space(2) },
  row: {
    minHeight: theme.size.touch,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space(3),
  },
  rowText: { flex: 1, gap: 2 },
  label: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body, flexShrink: 1 },
  detail: { color: theme.color.textDim, fontSize: theme.font.small },
  button: {
    paddingHorizontal: theme.space(4),
    minHeight: theme.size.control,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surfaceRaised,
    justifyContent: "center",
  },
  buttonText: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
  link: { minHeight: theme.size.touch, justifyContent: "center" },
  linkText: { color: theme.color.textDim, fontSize: theme.font.body },
});
