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
 * Once playing, the card is the shape of its video (a widescreen clip is a wide
 * card, a phone clip a tall one) and has its own controls, which are always
 * visible. The expand button opens the video full screen, where the phone may
 * be turned sideways to watch widescreen at its largest.
 *
 * The resolver arrives by context for the same reason a picture's does: cards
 * sit several renderer levels below anything that owns the socket.
 */
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ScreenOrientation from "expo-screen-orientation";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import type { wire } from "@pew2/protocol";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { saveVideoToDevice, storeVideo, type StoredVideo } from "./videoStore";
import { videosFromText, type ChatVideo } from "../videos";
import {
  DEFAULT_VIDEO_RATIO,
  formatClock,
  fractionToSeconds,
  progressFraction,
  SEEK_STEP_SECONDS,
  seekTarget,
  videoAspectRatio,
} from "../videoControls";

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

interface PlayerState {
  playing: boolean;
  /** Seconds into the video. */
  time: number;
  /** Seconds in all; 0 until the video has loaded. */
  duration: number;
  /** Width over height of the picture. */
  ratio: number;
}

/** What the controls show, kept current from the player's own events. */
function usePlayerState(player: VideoPlayer): PlayerState {
  const [playing, setPlaying] = useState(player.playing);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(player.duration);
  const [ratio, setRatio] = useState(() =>
    videoAspectRatio(player.videoTrack?.size.width, player.videoTrack?.size.height),
  );

  useEffect(() => {
    const subscriptions = [
      player.addListener("playingChange", ({ isPlaying }) => setPlaying(isPlaying)),
      player.addListener("timeUpdate", ({ currentTime }) => setTime(currentTime)),
      player.addListener("sourceLoad", ({ duration: loaded }) => setDuration(loaded)),
      player.addListener("videoTrackChange", ({ videoTrack }) =>
        setRatio(videoAspectRatio(videoTrack?.size.width, videoTrack?.size.height)),
      ),
    ];
    // Read once more now: a small local file can finish loading before the listeners exist.
    setPlaying(player.playing);
    setDuration(player.duration);
    setRatio(videoAspectRatio(player.videoTrack?.size.width, player.videoTrack?.size.height));
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [player]);

  return { playing, time, duration, ratio };
}

function ReadyVideo({ name, stored, onReload }: { name: string; stored: StoredVideo; onReload: () => void }) {
  const player = useVideoPlayer(stored.uri, (p) => {
    // A short clip is meant to be watched more than once: it repeats until paused.
    p.loop = true;
    p.timeUpdateEventInterval = 0.25;
    // The user tapped to watch it: start now rather than asking for a second tap.
    p.play();
  });
  const state = usePlayerState(player);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);

  const save = useCallback(async () => {
    haptics.tap();
    const result = await saveVideoToDevice(stored);
    setNote(result.status === "error" ? result.message : SAVE_MESSAGES[result.status]);
  }, [stored]);

  const togglePlay = useCallback(() => {
    haptics.tap();
    if (player.playing) player.pause();
    else player.play();
  }, [player]);

  return (
    <View style={styles.frame}>
      {/* One player, one picture at a time: while the full-screen viewer shows it,
          the card keeps its place with a black box the same shape. */}
      {expanded ? (
        <View style={[styles.video, { aspectRatio: state.ratio }]} />
      ) : (
        // A tap on the picture plays or pauses. As a Pressable it also claims the
        // touch: a message opens a "Copy / Cancel" menu on a long press, and
        // pressing the video must not count as holding the message.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={state.playing ? "Pause video" : "Play video"}
          onPress={togglePlay}
        >
          <VideoView
            player={player}
            // The player's own bar stuck on screen over a short clip and never showed
            // over a long one, so the controls below are drawn by the card instead.
            nativeControls={false}
            contentFit="contain"
            allowsPictureInPicture={false}
            style={[styles.video, { aspectRatio: state.ratio }]}
          />
        </Pressable>
      )}
      <VideoControls
        player={player}
        state={state}
        name={name}
        onSave={() => void save()}
        onReload={onReload}
        onExpand={() => {
          haptics.tap();
          setExpanded(true);
        }}
      />
      {!!note && <Text style={styles.note}>{note}</Text>}
      {expanded && (
        <VideoViewer
          player={player}
          state={state}
          name={name}
          onSave={() => void save()}
          onClose={() => setExpanded(false)}
        />
      )}
    </View>
  );
}

interface VideoControlsProps {
  player: VideoPlayer;
  state: PlayerState;
  name: string;
  onSave: () => void;
  onReload?: () => void;
  /** Shown only where the video can be made larger. */
  onExpand?: () => void;
  /** Shown only in the full-screen viewer, in place of the expand button. */
  onClose?: () => void;
}

/** Name, progress bar, and the buttons: always visible, unlike the player's own bar. */
function VideoControls({ player, state, name, onSave, onReload, onExpand, onClose }: VideoControlsProps) {
  const [trackWidth, setTrackWidth] = useState(0);

  const togglePlay = useCallback(() => {
    haptics.tap();
    if (player.playing) player.pause();
    else player.play();
  }, [player]);

  const skip = useCallback(
    (delta: number) => {
      haptics.tap();
      player.currentTime = seekTarget(player.currentTime, delta, player.duration);
    },
    [player],
  );

  const seekToTap = useCallback(
    (x: number) => {
      if (trackWidth > 0) player.currentTime = fractionToSeconds(x / trackWidth, player.duration);
    },
    [player, trackWidth],
  );

  return (
    <View style={styles.controls}>
      <View style={styles.headerRow}>
        <Text style={[styles.name, styles.headerName]} numberOfLines={1}>
          {name}
        </Text>
        <ControlButton label="Save this video to your gallery" onPress={onSave}>
          <Ionicons name="download-outline" size={22} color={theme.color.text} />
        </ControlButton>
        {onReload && (
          <ControlButton label="Download this video again" onPress={onReload}>
            <Ionicons name="refresh" size={22} color={theme.color.text} />
          </ControlButton>
        )}
      </View>
      <View style={styles.progressRow}>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel="Video progress. Tap to jump"
          hitSlop={{ top: theme.space(3), bottom: theme.space(3) }}
          onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
          onPress={(event) => seekToTap(event.nativeEvent.locationX)}
          style={styles.track}
        >
          <View
            pointerEvents="none"
            style={[styles.fill, { width: `${progressFraction(state.time, state.duration) * 100}%` }]}
          />
        </Pressable>
        <Text style={styles.time}>
          {formatClock(state.time)} / {formatClock(state.duration)}
        </Text>
      </View>
      <View style={styles.buttons}>
        <ControlButton label={`Back ${SEEK_STEP_SECONDS} seconds`} onPress={() => skip(-SEEK_STEP_SECONDS)}>
          <Text style={styles.skipText}>-{SEEK_STEP_SECONDS}s</Text>
        </ControlButton>
        <ControlButton label={state.playing ? "Pause" : "Play"} onPress={togglePlay}>
          <Ionicons name={state.playing ? "pause" : "play"} size={24} color={theme.color.text} />
        </ControlButton>
        <ControlButton label={`Forward ${SEEK_STEP_SECONDS} seconds`} onPress={() => skip(SEEK_STEP_SECONDS)}>
          <Text style={styles.skipText}>+{SEEK_STEP_SECONDS}s</Text>
        </ControlButton>
        <View style={styles.spacer} />
        {onExpand && (
          <ControlButton label="Open the video full screen" onPress={onExpand}>
            <Ionicons name="expand-outline" size={22} color={theme.color.text} />
          </ControlButton>
        )}
        {onClose && (
          <ControlButton label="Close full screen" onPress={onClose}>
            <Ionicons name="contract-outline" size={22} color={theme.color.text} />
          </ControlButton>
        )}
      </View>
    </View>
  );
}

/** One round button in the control row. */
function ControlButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={theme.space(1)}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      {children}
    </Pressable>
  );
}

/**
 * The video full screen, over everything, turning with the phone.
 *
 * The app is locked to portrait; like the picture viewer, this hands rotation
 * back to the phone while open (its own auto-rotate setting still decides) and
 * locks portrait again on close. Turn the phone sideways and a widescreen clip
 * fills the screen.
 */
function VideoViewer({
  player,
  state,
  name,
  onSave,
  onClose,
}: {
  player: VideoPlayer;
  state: PlayerState;
  name: string;
  onSave: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (Platform.OS !== "android") return;
    ScreenOrientation.unlockAsync().catch((error: unknown) => {
      console.warn("[VideoViewer] could not release screen rotation", error);
    });
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch((error: unknown) => {
        console.warn("[VideoViewer] could not restore portrait", error);
      });
    };
  }, []);

  const togglePlay = useCallback(() => {
    haptics.tap();
    if (player.playing) player.pause();
    else player.play();
  }, [player]);

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      // Android's hardware back closes the viewer rather than the app.
      onRequestClose={onClose}
      statusBarTranslucent
      supportedOrientations={["portrait", "landscape"]}
    >
      <View
        style={[
          styles.viewer,
          { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={state.playing ? "Pause video" : "Play video"}
          onPress={togglePlay}
          style={styles.viewerVideo}
        >
          <VideoView
            player={player}
            nativeControls={false}
            contentFit="contain"
            allowsPictureInPicture={false}
            style={styles.viewerVideoFill}
          />
        </Pressable>
        <VideoControls player={player} state={state} name={name} onSave={onSave} onClose={onClose} />
      </View>
    </Modal>
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
  // Full width, as tall as the video's own shape makes it, but never taller than a phone screen's worth.
  video: { width: "100%", aspectRatio: DEFAULT_VIDEO_RATIO, maxHeight: VIDEO_HEIGHT, backgroundColor: "#000" },
  controls: { gap: theme.space(2), paddingHorizontal: theme.space(3), paddingVertical: theme.space(2) },
  headerRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  headerName: { flex: 1 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: theme.space(3) },
  track: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.color.border,
    overflow: "hidden",
  },
  fill: { height: "100%", backgroundColor: theme.color.accent },
  time: { color: theme.color.textDim, fontSize: theme.font.tiny, fontVariant: ["tabular-nums"] },
  buttons: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  spacer: { flex: 1 },
  button: {
    minWidth: 44,
    height: 40,
    paddingHorizontal: theme.space(2),
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.surfaceRaised,
  },
  buttonPressed: { backgroundColor: theme.color.surfacePressed },
  skipText: { color: theme.color.text, fontSize: theme.font.small, fontWeight: "600" },
  note: {
    color: theme.color.textDim,
    fontSize: theme.font.tiny,
    paddingHorizontal: theme.space(3),
    paddingBottom: theme.space(2),
  },
  viewer: { flex: 1, backgroundColor: "rgba(0,0,0,0.96)" },
  viewerVideo: { flex: 1 },
  viewerVideoFill: { flex: 1, width: "100%", height: "100%" },
});
