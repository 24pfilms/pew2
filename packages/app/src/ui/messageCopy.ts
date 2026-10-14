/**
 * What a long press on a message offers to copy. Pure and Expo-free so the
 * rule is testable; `copyMenu.ts` is the native half that shows it.
 *
 * Copy buttons were removed from every message: holding a message is the only
 * way to copy it. A hold inside a fenced code block offers that block first.
 */
export type CopyOption = { label: string; text: string };

/** The menu entries, in order. Empty when there is nothing to copy. */
export function copyOptions(message: string, code?: string): CopyOption[] {
  const options: CopyOption[] = [];
  if (code !== undefined && code.length > 0) options.push({ label: "Copy code", text: code });
  if (message.trim().length > 0) {
    options.push({ label: options.length > 0 ? "Copy message" : "Copy", text: message });
  }
  return options;
}
