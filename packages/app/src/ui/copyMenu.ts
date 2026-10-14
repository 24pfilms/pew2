/**
 * The long-press copy menu: ActionSheetIOS on iOS, an Alert elsewhere. No new
 * native dependency. The options themselves come from `messageCopy.ts`.
 */
import { createContext } from "react";
import * as Clipboard from "expo-clipboard";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { writeToClipboard } from "./clipboard";
import { haptics } from "./haptics";
import { copyOptions } from "./messageCopy";

/** The text of the message a code block sits in, so its menu can offer both. */
export const MessageTextContext = createContext<string | undefined>(undefined);

async function copy(text: string): Promise<void> {
  // No toast exists in this app; the success haptic is the confirmation.
  if (await writeToClipboard(text, Clipboard.setStringAsync)) haptics.finished();
  else haptics.failed();
}

export function openCopyMenu(message: string, code?: string): void {
  const options = copyOptions(message, code);
  if (options.length === 0) return;
  haptics.tap();
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...options.map((option) => option.label), "Cancel"], cancelButtonIndex: options.length },
      (index) => {
        const chosen = options[index];
        if (chosen) void copy(chosen.text);
      },
    );
    return;
  }
  Alert.alert("", undefined, [
    ...options.map((option) => ({ text: option.label, onPress: () => void copy(option.text) })),
    { text: "Cancel", style: "cancel" as const },
  ], { cancelable: true });
}
