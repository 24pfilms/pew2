/**
 * A finished video from the agent, as a card in the transcript.
 *
 * The agent names a file on the desktop (usually in its closing message), and
 * the phone cannot read that disk. The card shows the file's name and waits:
 * nothing is downloaded until it is tapped, because a clip is megabytes and
 * mobile data is not free. A tap asks the daemon for the bytes over the same
 * encrypted link everything else uses, stores them in the app's cache, and
 * plays them. From there the video can be saved to the gallery.
 *
 * The resolver arrives by context for the same reason a picture's does: cards
 * sit several renderer levels below anything that owns the socket.
 */
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useVideoPlayer, VideoView } from "expo-video";
import type { wire } from "@pew2/protocol";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { saveVideoToDevice, storeVideo, type StoredVideo } from "./videoStore";
import { videosFromText, type ChatVideo } from "../videos";

export interface VideoResolver {
  /** Ask the computer for a video; always resolves, with `error` set when it cannot deliver. */
  fetchVideo: (uri: string) => Promise<wire.VideoData>;
}

const VideoResolverContext = createContext<VideoResolver | undefined>(undefined);

export const VideoResolverProvider = VideoResolverContext.Provider;

/**
 * Videos already downloaded in this run, by path. The transcript is a recycling
 * list, so a card that scrolls away and back is a new mount; without this it
 * would ask the computer for the same clip again.
 */
const downloaded = new Map<string, StoredVideo>();

type CardState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; video: StoredVideo }
  | { status: "error"; message: string };

/** Tall enough for a vertical clip to be worth watching, short enough to scroll past. */
const VIDEO_HEIGHT = 380;

const SAVE_MESSAGES = {
  saved: "Saved to your gallery",
  shared: "Opened the share sheet",
  denied: "Gallery access was declined",
} as const;

function VideoCardView({ video }: { video: ChatVideo }) {
  const resolver = useContext(VideoResolverContext);
  const [state, setState] = useState<CardState>(() => {
    const have = downloaded.get(video.src);
    return have ? { status: "ready", video: have } : { status: "idle" };
  });
  // The reply can land after the cell was recycled away; setting state then is noise.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    haptics.tap();
    if (!resolver) {
      setState({ status: "error", message: "Not connected to your computer" });
      return;
    }
    setState({ status: "loading" });
    const reply = await resolver.fetchVideo(video.src);
    let next: CardState;
    if (reply.dataUri) {
      try {
        const stored = await storeVideo(video.src, reply.dataUri);
        downloaded.set(video.src, stored);
        next = { status: "ready", video: stored };
      } catch (error) {
        next = {
          status: "error",
          message: error instanceof Error ? error.message : "Could not keep the video on this phone",
        };
      }
    } else {
      next = { status: "error", message: reply.error ?? "Could not load this video" };
    }
    if (mounted.current) setState(next);
  }, [resolver, video.src]);

  if (state.status === "ready") {
    return <ReadyVideo name={video.name} stored={state.video} onReload={() => void load()} />;
  }

  const loading = state.status === "loading";
  const failed = state.status === "error";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        loading
          ? `Loading video ${video.name}`
          : failed
            ? `Video failed to load. ${state.message}. Tap to retry`
            : `Video ${video.name}. Tap to load and play`
      }
      disabled={loading}
      onPress={() => void load()}
      style={({ pressed }) => [styles.frame, styles.card, pressed && { backgroundColor: theme.color.surfacePressed }]}
    >
      {loading ? (
        <ActivityIndicator color={theme.color.textDim} />
      ) : (
        <Ionicons name={failed ? "alert-circle-outline" : "play-circle-outline"} size={28} color={theme.color.textDim} />
      )}
      <View style={styles.cardText}>
        <Text style={styles.name} numberOfLines={1}>
          {video.name}
        </Text>
        <Text style={failed ? styles.errorText : styles.hint} numberOfLines={3}>
          {loading ? "Getting it from your computer..." : failed ? state.message : "Video: tap to load"}
        </Text>
      </View>
      {failed && <Text style={styles.retryText}>Tap to retry</Text>}
    </Pressable>
  );
}

function ReadyVideo({ name, stored, onReload }: { name: string; stored: StoredVideo; onReload: () => void }) {
  const player = useVideoPlayer(stored.uri, (p) => {
    p.loop = false;
    // The user tapped to watch it: start now rather than asking for a second tap.
    p.play();
  });
  const [note, setNote] = useState<string | undefined>(undefined);

  const save = useCallback(async () => {
    haptics.tap();
    const result = await saveVideoToDevice(stored);
    setNote(result.status === "error" ? result.message : SAVE_MESSAGES[result.status]);
  }, [stored]);

  return (
    <View style={styles.frame}>
      <VideoView
        player={player}
        nativeControls
        contentFit="contain"
        allowsFullscreen
        allowsPictureInPicture={false}
        style={styles.video}
      />
      <View style={styles.actions}>
        <Text style={[styles.name, styles.actionName]} numberOfLines={1}>
          {name}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save this video to your gallery"
          hitSlop={theme.space(2)}
          onPress={() => void save()}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Ionicons name="download-outline" size={20} color={theme.color.text} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Download this video again"
          hitSlop={theme.space(2)}
          onPress={onReload}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Ionicons name="refresh" size={20} color={theme.color.text} />
        </Pressable>
      </View>
      {!!note && <Text style={styles.note}>{note}</Text>}
    </View>
  );
}

export const VideoCard = memo(VideoCardView, (before, after) => before.video.src === after.video.src);

/** The video cards under an agent message's text, for each video path the message names. */
export function ChatVideos({ text }: { text: string }) {
  const videos = useMemo(() => videosFromText(text), [text]);
  if (videos.length === 0) return null;
  return (
    <View style={styles.stack}>
      {videos.map((video) => (
        <VideoCard key={video.src} video={video} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { width: "100%", gap: theme.space(2), marginTop: theme.space(1) },
  frame: {
    width: "100%",
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    overflow: "hidden",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(3),
  },
  cardText: { flex: 1, gap: 2 },
  name: { color: theme.color.text, fontSize: theme.font.small, fontWeight: "600" },
  hint: { color: theme.color.textDim, fontSize: theme.font.small },
  errorText: { color: theme.color.textDim, fontSize: theme.font.small },
  retryText: { color: theme.color.accent, fontSize: theme.font.tiny, fontWeight: "600" },
  video: { width: "100%", height: VIDEO_HEIGHT, backgroundColor: "#000" },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  actionName: { flex: 1 },
  action: { padding: theme.space(1), borderRadius: theme.radius.md },
  actionPressed: { backgroundColor: theme.color.surfacePressed },
  note: {
    color: theme.color.textDim,
    fontSize: theme.font.tiny,
    paddingHorizontal: theme.space(3),
    paddingBottom: theme.space(2),
  },
});
