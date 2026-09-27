/**
 * Full-screen view of one picture, and the only place it can be saved.
 *
 * Transcript images are small and sit inside a scrolling list, so the save
 * action cannot live on the thumbnail: a button there competes with the scroll
 * gesture, and a long-press that silently writes to the camera roll gives no
 * confirmation. Tapping opens this instead — the picture at full size, with
 * Save and Share as ordinary buttons and the result stated in words.
 *
 * A real `Modal`, unlike `ConfigPicker`: this *is* leaving the conversation for
 * a moment, and the keyboard should drop.
 *
 * On Android the viewer is the one screen that turns with the phone: a wide
 * screenshot is unreadable held upright. The rest of the app stays portrait —
 * its layout is built for it — so rotation is released on open and taken back
 * on close.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
// Share expo-image's original source cache with the transcript.
import { Image } from "expo-image";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as ScreenOrientation from "expo-screen-orientation";
import { fitContainer, ResumableZoom } from "react-native-zoom-toolkit";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { saveImageToDevice, shareImage, type SaveResult } from "./imageSaver";
import type { ChatImage as ChatImageModel } from "../images";

/** What the last save/share attempt did, shown under the buttons. */
type Feedback = { tone: "ok" | "bad"; text: string };

function describe(result: SaveResult): Feedback {
  switch (result.status) {
    case "saved":
      return { tone: "ok", text: "Saved to your photos" };
    case "shared":
      return { tone: "ok", text: "Shared" };
    case "denied":
      // Not an error the app can fix, so it says where the switch is.
      return { tone: "bad", text: "Photos access is off — enable it in Settings" };
    case "error":
      return { tone: "bad", text: result.message };
  }
}

export function ImageViewer({
  image,
  resolvedSrc,
  visible,
  onClose,
}: {
  image: ChatImageModel;
  /** The displayable source — a data URI for anything that came off the desktop. */
  resolvedSrc: string;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<"save" | "share" | undefined>(undefined);
  const [feedback, setFeedback] = useState<Feedback | undefined>(undefined);
  // Tapping the picture hides the close and save controls, so it can have the
  // whole screen — most of all when the phone is on its side.
  const [chromeHidden, setChromeHidden] = useState(false);
  const toggleChrome = useCallback(() => setChromeHidden((hidden) => !hidden), []);

  // Reopening is a fresh attempt: a stale "Saved" from last time would read as
  // confirmation of a save that has not happened yet.
  useEffect(() => {
    if (!visible) {
      setFeedback(undefined);
      setBusy(undefined);
      setChromeHidden(false);
    }
  }, [visible]);

  // Turning with the phone, while open. `unlockAsync` hands the choice back to
  // the phone, so its own auto-rotate setting still decides; closing locks the
  // app back to the portrait its manifest declares.
  useEffect(() => {
    if (Platform.OS !== "android" || !visible) return;
    ScreenOrientation.unlockAsync().catch((error: unknown) => {
      console.warn("[ImageViewer] could not release screen rotation", error);
    });
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
        (error: unknown) => {
          console.warn("[ImageViewer] could not restore portrait", error);
        },
      );
    };
  }, [visible]);

  const run = useCallback(
    async (kind: "save" | "share") => {
      if (busy) return;
      setBusy(kind);
      setFeedback(undefined);
      const result =
        kind === "save"
          ? await saveImageToDevice(image, resolvedSrc)
          : await shareImage(image, resolvedSrc);
      // Named by meaning, so a refused permission feels different from a write
      // that actually landed.
      if (result.status === "saved" || result.status === "shared") haptics.finished();
      else haptics.failed();
      setFeedback(describe(result));
      setBusy(undefined);
    },
    [busy, image, resolvedSrc],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Android's hardware back closes the viewer rather than the app.
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Its own gesture root: a Modal is a separate native window on Android,
          outside the one App.tsx sets up, and pinch would otherwise never fire. */}
      <GestureHandlerRootView style={styles.backdrop}>
        {/* Tapping the surround dismisses, matching every other overlay here. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Close image"
          onPress={onClose}
        />

        {Platform.OS === "ios" ? (
          <IosViewerImage key={resolvedSrc} uri={resolvedSrc} alt={image.alt || "Image from the agent"} />
        ) : (
          <ZoomableImage
            key={resolvedSrc}
            uri={resolvedSrc}
            alt={image.alt || "Image from the agent"}
            onTap={toggleChrome}
          />
        )}

        {!chromeHidden && (
        <View style={[styles.closeRow, { top: insets.top + theme.headerInset }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close image"
            hitSlop={12}
            onPress={onClose}
            style={styles.closeButton}
          >
            <Ionicons name="close" size={20} color={theme.color.text} />
          </Pressable>
        </View>
        )}

        {!chromeHidden && (
        <View
          style={[
            styles.actions,
            // Over the picture on Android rather than beneath it: the picture
            // fills the screen there, so hiding these gives it all back without
            // resizing it — and resetting the zoom — under the user's fingers.
            Platform.OS !== "ios" && styles.overlayActions,
            { paddingBottom: insets.bottom + theme.space(4) },
          ]}
        >
          {!!feedback && (
            <Text
              style={[
                styles.feedback,
                feedback.tone === "bad" && { color: theme.color.danger },
              ]}
            >
              {feedback.text}
            </Text>
          )}

          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save image to photos"
              disabled={!!busy}
              onPress={() => void run("save")}
              style={({ pressed }) => [
                styles.button,
                styles.primaryButton,
                pressed && { opacity: 0.8 },
                !!busy && { opacity: 0.6 },
              ]}
            >
              {busy === "save" ? (
                <ActivityIndicator color={theme.color.text} size="small" />
              ) : (
                <Ionicons name="download-outline" size={18} color={theme.color.text} />
              )}
              <Text style={styles.buttonText}>Save</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share image"
              disabled={!!busy}
              onPress={() => void run("share")}
              style={({ pressed }) => [
                styles.button,
                pressed && { backgroundColor: theme.color.surfacePressed },
                !!busy && { opacity: 0.6 },
              ]}
            >
              {busy === "share" ? (
                <ActivityIndicator color={theme.color.text} size="small" />
              ) : (
                <Ionicons name="share-outline" size={18} color={theme.color.text} />
              )}
              <Text style={styles.buttonText}>Share</Text>
            </Pressable>
          </View>
        </View>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * Pinch, drag and double-tap zoom for Android.
 *
 * React Native's ScrollView zooms on iOS only, which left an Android picture
 * impossible to enlarge. The zoom library measures its bounds against the child,
 * so the picture is sized to fit this box at its own aspect ratio — and re-fitted
 * when the box changes, which is what turning the phone does.
 *
 * `allowDownscaling` off: the bitmap otherwise shrinks to the fitted size, and
 * zooming would only enlarge that blur.
 */
function ZoomableImage({ uri, alt, onTap }: { uri: string; alt: string; onTap: () => void }) {
  const [box, setBox] = useState<{ width: number; height: number } | undefined>(undefined);
  const [resolution, setResolution] = useState<{ width: number; height: number } | undefined>(
    undefined,
  );
  const fitted =
    box && resolution && resolution.width > 0 && resolution.height > 0
      ? fitContainer(resolution.width / resolution.height, box)
      : undefined;
  const cachePolicy = uri.startsWith("data:") ? "memory" : "memory-disk";

  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={({ nativeEvent: { layout } }) => setBox({ width: layout.width, height: layout.height })}
    >
      {fitted && box ? (
        // Keyed on the box so a rotation starts from a clean fit rather than a
        // zoom computed for the other orientation.
        <ResumableZoom
          key={`${box.width}x${box.height}`}
          maxScale={MAX_ZOOM}
          extendGestures
          onTap={onTap}
        >
          <Image
            accessible
            accessibilityRole="image"
            accessibilityLabel={alt}
            source={{ uri }}
            contentFit="contain"
            allowDownscaling={false}
            cachePolicy={cachePolicy}
            transition={0}
            style={fitted}
          />
        </ResumableZoom>
      ) : (
        // Loaded once at full size to learn its dimensions; the zoomable copy
        // above then comes straight from the memory cache.
        <Image
          accessible
          accessibilityRole="image"
          accessibilityLabel={alt}
          source={{ uri }}
          contentFit="contain"
          cachePolicy={cachePolicy}
          transition={0}
          style={styles.imageFill}
          onLoad={({ source }) => setResolution({ width: source.width, height: source.height })}
        />
      )}
    </View>
  );
}

/** Same ceiling as the iOS viewer, so a detail is as reachable on either. */
const MAX_ZOOM = 8;

/** iOS supplies native pinch/pan; a tap is a single-pointer zoom alternative. */
function IosViewerImage({ uri, alt }: { uri: string; alt: string }) {
  const scroll = useRef<ScrollView>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoomed, setZoomed] = useState(false);
  const toggleZoom = () => {
    const scale = zoomed ? 1 : 3;
    scroll.current?.scrollResponderZoomTo({
      x: size.width * (1 - 1 / scale) / 2,
      y: size.height * (1 - 1 / scale) / 2,
      width: size.width / scale,
      height: size.height / scale,
      animated: false,
    });
  };
  const picture = (
    <Image
      accessible={false}
      accessibilityRole="image"
      accessibilityLabel={alt}
      source={{ uri }}
      contentFit="contain"
      // Native fit-size resampling is sharper than GPU minification on iOS.
      // Once magnified, keep original pixels, not an enlarged fit-size bitmap.
      allowDownscaling={!zoomed}
      cachePolicy={uri.startsWith("data:") ? "memory" : "memory-disk"}
      transition={0}
      style={styles.imageFill}
    />
  );
  return (
    <View style={styles.image} onLayout={({ nativeEvent: { layout } }) => {
      setSize({ width: layout.width, height: layout.height });
      setZoomed(false);
    }}>
      {size.width > 0 && size.height > 0 && (
        <ScrollView
          key={`${size.width}:${size.height}`}
          ref={scroll}
          style={styles.image}
          contentContainerStyle={size}
          minimumZoomScale={1}
          maximumZoomScale={8}
          bouncesZoom={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          contentInsetAdjustmentBehavior="never"
          onScroll={event => setZoomed(event.nativeEvent.zoomScale > 1)}
          scrollEventThrottle={16}
        >
          <Pressable
            style={styles.imageFill}
            accessibilityRole="button"
            accessibilityLabel={`${alt}. ${zoomed ? "Reset zoom" : "Zoom in"}`}
            accessibilityHint="Pinch to zoom and drag to move around the image"
            onPress={toggleZoom}
          >
            {picture}
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    // Nearly opaque rather than a tint: a picture judged against the
    // conversation behind it is a picture you cannot judge.
    backgroundColor: "rgba(0,0,0,0.94)",
    justifyContent: "center",
  },
  closeRow: { position: "absolute", right: theme.gutter, zIndex: 2 },
  closeButton: {
    width: theme.size.control,
    height: theme.size.control,
    borderRadius: theme.radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.surfaceRaised,
  },
  image: { flex: 1, width: "100%" },
  imageFill: { flex: 1, width: "100%" },
  overlayActions: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  actions: {
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(3),
    gap: theme.space(2),
    alignItems: "center",
  },
  feedback: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    textAlign: "center",
  },
  buttonRow: { flexDirection: "row", gap: theme.space(3) },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    minHeight: theme.size.control,
    paddingHorizontal: theme.space(5),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surface,
  },
  primaryButton: { backgroundColor: theme.color.surfaceRaised },
  buttonText: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
});
