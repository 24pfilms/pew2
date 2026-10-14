/**
 * Files staged for the next message, and the sheet that adds them.
 */
import { useCallback, useRef, useState } from "react";
import { Alert, Keyboard } from "react-native";
import type { AttachmentSource } from "./AttachmentSheet";
import { addAttachments, MAX_ATTACHMENTS, type PendingAttachment } from "../attachments";
import { pickFiles, pickPhotos, takePhoto } from "./attachmentPicker";

export function useAttachments(devSheet: string | undefined) {
  // Files staged for the next message. Cleared with the draft on send, because
  // the two are one message.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Mirror, for the async gap while a photo is being read and downscaled.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [attachOpen, setAttachOpen] = useState(() => devSheet === "attach");

  const openAttach = useCallback(() => {
    Keyboard.dismiss();
    setAttachOpen(true);
  }, []);
  const closeAttach = useCallback(() => setAttachOpen(false), []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((file) => file.id !== id));
  }, []);

  const pickAttachment = useCallback(
    (source: AttachmentSource) => {
      setAttachOpen(false);
      // Reading and downscaling a photo takes a moment, so the list is read
      // through its ref mirror afterwards rather than from this closure: two
      // overlapping picks would otherwise have the second overwrite the first.
      void (async () => {
        const room = MAX_ATTACHMENTS - attachmentsRef.current.length;
        const outcome =
          source === "camera"
            ? await takePhoto()
            : source === "files"
              ? await pickFiles(room)
              : await pickPhotos(room);

        // Backing out of the picker is an ordinary thing to do and says nothing.
        if (outcome.status === "cancelled") return;
        if (outcome.status !== "picked") {
          Alert.alert("Attach", outcome.message);
          return;
        }

        // Merged out here, not in an updater: React may invoke an updater
        // twice, and an alert is not something to show twice.
        const merged = addAttachments(attachmentsRef.current, outcome.attachments);
        setAttachments(merged.attachments);
        if (merged.rejected) Alert.alert("Attach", merged.rejected);
      })();
    },
    [],
  );

  return {
    attachments,
    setAttachments,
    attachmentsRef,
    attachOpen,
    setAttachOpen,
    openAttach,
    closeAttach,
    removeAttachment,
    pickAttachment,
  };
}
