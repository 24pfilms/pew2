/**
 * A new GG Coder goal: name, what it should achieve, context folders from the
 * desktop (the `workspaces` browse), optional standing instructions →
 * `goal.create`. Closes when the daemon answers ok; shows its error otherwise.
 *
 * Full screen, not a sheet (the user's call): a goal is written, not tapped —
 * a long goal text, a folder browse and instructions are cramped in a card
 * over the chat. Same shape as the QR scanner: a native full-screen modal,
 * close at the top left, the form scrolling clear of the keyboard, and the
 * Stage "launch pad" at the bottom: hold Ken until the dot ring fills.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, Modal, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions, type TextInputProps } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardAwareScrollView, KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { CircleButton } from "./controls";
import { DotGlyph } from "./stage/DotGlyph";
import { FolderPicker } from "./FolderPicker";
import { Led } from "./stage/Led";
import { dashedOutline } from "./stage/DashedRule";
import { StageButton } from "./stage/StageButton";
import { Pew } from "../pew/Pew";
import { AgentColorProvider } from "./stage/agentColor";
import { KEN_COLOR } from "../pew/palette";
import { suggestGoalName } from "../goalsAgent";
import type { GoalResult, GoalSummary } from "../ggState";
import type { WorkspaceBrowse } from "../useDaemon";
import { EASE_OUT } from "./motion/ease";
import { DUR, SPRING } from "../motion";
import { addAttachments, MAX_ATTACHMENTS, toWireAttachments, type PendingAttachment, type WireAttachment } from "../attachments";
import { pickFiles } from "./attachmentPicker";
import { LaunchFx, type LaunchFxValues } from "./LaunchFx";
import { sounds } from "./sounds";
import { BURST_MIN_S, fxKenScale, fxShake, RING_DOTS, RING_SCALE, type FxScene } from "../launchFx";

interface NewGoalSheetProps {
  visible: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; goal: string; context: string[]; instructions?: string; files?: WireAttachment[] }) => string | undefined;
  results: Record<string, GoalResult>;
  onCreated: (goal: GoalSummary | undefined) => void;
  browse?: WorkspaceBrowse;
  onBrowse: (path?: string) => void;
  /** Goal text typed into the composer; the name is suggested from it. */
  prefill?: string;
  /** Connected to the computer (the folder picker retries when this turns true). */
  online?: boolean;
}

function NewGoalSheetView(props: NewGoalSheetProps) {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    if (props.visible) setQuiet(false);
  }, [props.visible]);
  return (
    <Modal
      visible={props.visible}
      // Transparent, so the launch can open a hole onto the goal's session
      // behind it; the screen paints its own background. After a launch it
      // leaves without the slide: the reveal already took it away.
      animationType={quiet ? "none" : "slide"}
      transparent
      onRequestClose={props.onClose}
    >
      {/* A native modal is its own window: the app's gesture, keyboard and
          safe-area roots do not reach into it, so it brings its own. */}
      <GestureHandlerRootView style={styles.fill}>
        <SafeAreaProvider>
          <KeyboardProvider>
            {/* Everything lit on this screen is GG Goals' own purple (Ken), not
                the chat's agent colour behind it. */}
            <AgentColorProvider value={KEN_COLOR}>
              <NewGoalScreen {...props} onQuietExit={() => setQuiet(true)} />
            </AgentColorProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** The steps, in order. The last one is launching. */
const STEPS = ["name", "goal", "context", "instructions", "launch"] as const;
/** How long a launch waits for the computer before saying it heard nothing. */
const LAUNCH_TIMEOUT_MS = 20_000;
type Step = (typeof STEPS)[number];
const STEP_TITLE: Record<Step, string> = {
  name: "Name it",
  goal: "What's the goal?",
  context: "Any files or folders?",
  instructions: "Any rules to follow?",
  launch: "Hold Ken to launch",
};

/**
 * One step at a time (the user's call: the single form was too cluttered).
 * Ken (GG Goals' own Pew) stays above every step, centred, keeping you
 * company; each step is just a title and its field, no descriptions. Next
 * (top right) and Back (top left, beside Close) move between steps, clear of
 * the keyboard; the last step is the launch pad.
 */
function NewGoalScreen({ visible, onClose, onCreate, results, onCreated, browse, onBrowse, prefill, online, onQuietExit }: NewGoalSheetProps & { onQuietExit: () => void }) {
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState<string[]>([]);
  // Files picked on this phone. They travel with the goal and are saved on the
  // computer, so they show in the same row as the folders chosen there.
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const plain = usePlainLaunch();
  // The launch, all on the UI thread (see LaunchFx). `launched` is the React
  // side of the same fact: the wizard under the blast stops taking touches.
  const fx: LaunchFxValues = {
    clock: useSharedValue(0),
    charge: useSharedValue(0),
    burst: useSharedValue(-1),
    reveal: useSharedValue(0),
    fade: useSharedValue(1),
  };
  const [launched, setLaunched] = useState(false);
  const launchedRef = useRef(false);
  const [waitingLong, setWaitingLong] = useState(false);
  const [scene, setScene] = useState<FxScene>();
  const firedAt = useRef(0);
  /** The create has been answered: nothing may say "Launching" after this. */
  const answered = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (ms: number, run: () => void) => {
    timers.current.push(setTimeout(run, ms));
  };
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (!visible) return;
    clearTimers();
    fx.charge.value = 0;
    fx.burst.value = -1;
    fx.reveal.value = 0;
    fx.fade.value = 1;
    launchedRef.current = false;
    setLaunched(false);
    setWaitingLong(false);
    // `EXPO_PUBLIC_DEV_GOAL_STEP=<step>` (development only) opens on that step,
    // with a name and goal filled in, for checking it on the simulator.
    const devStep = __DEV__ ? (process.env.EXPO_PUBLIC_DEV_GOAL_STEP as Step | undefined) : undefined;
    setStep(devStep && STEPS.includes(devStep) ? devStep : "name");
    setName(devStep ? "Pew2 polish" : prefill ? suggestGoalName(prefill) : "");
    setGoal(devStep ? "Make every screen feel alive." : (prefill ?? ""));
    setContext([]);
    setFiles([]);
    setInstructions("");
    setPending(undefined);
    setError(undefined);
    // Shared values are stable; the reset belongs to opening only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, prefill]);

  /** Calls the blast off: the cover fades and the wizard comes back as it was. */
  const abortLaunch = () => {
    clearTimers();
    setWaitingLong(false);
    if (!launchedRef.current) return;
    launchedRef.current = false;
    setLaunched(false);
    const { burst, charge, reveal, fade } = fx;
    fade.value = withTiming(0, { duration: DUR.dissolve, easing: EASE_OUT }, () => {
      burst.value = -1;
      charge.value = 0;
      reveal.value = 0;
      fade.value = 1;
    });
  };

  /** The session is open behind the cover: widen the hole onto it, then go. */
  const openUp = () => {
    setWaitingLong(false);
    const done = () => {
      onQuietExit();
      later(60, onClose);
    };
    sounds.play("reveal");
    fx.reveal.value = withTiming(1, { duration: REVEAL_MS, easing: Easing.linear }, (finished) => {
      if (finished) runOnJS(done)();
    });
  };

  const result = pending ? results[pending] : undefined;
  // A launch that hears nothing back gives up rather than sitting on
  // "Launching" for ever: a dropped connection or an older pew2 that never
  // answers both used to leave this page with no way forward but closing it.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => {
      setPending(undefined);
      abortLaunch();
      haptics.failed();
      setError("Your computer didn't answer. Check it's online, then hold Ken again.");
    }, LAUNCH_TIMEOUT_MS);
    return () => clearTimeout(t);
    // The clock belongs to this launch: `abortLaunch` is a fresh closure every
    // render, and listing it would restart the timeout on each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  // How many phone files went out with the create, to check they arrived.
  const sentFiles = useRef(0);
  useEffect(() => {
    if (!result) return;
    answered.current = true;
    setWaitingLong(false);
    setPending(undefined);
    if (result.ok) {
      // An older pew2 on the computer drops `files` without a word and its
      // reply carries no count: say so rather than let the goal run without
      // the files the user picked.
      if (sentFiles.current > 0 && result.files === undefined) {
        Alert.alert(
          "Files not attached",
          "The goal was created, but pew2 on your computer is too old to receive files from your phone. Update it, then add them in goal settings.",
        );
      }
      const created = result.goal;
      if (!launchedRef.current || !created) {
        onCreated(created);
        onClose();
        return;
      }
      // Let the blast play out, then open the goal's session behind the cover
      // (a beat for it to mount) and widen the hole onto it. Timers live in a
      // ref, not this effect: clearing `pending` re-runs it straight away.
      const wait = Math.max(0, BURST_MIN_S * 1000 - (Date.now() - firedAt.current));
      later(wait, () => {
        onCreated(created);
        later(SESSION_MOUNT_MS, openUp);
      });
    } else {
      abortLaunch();
      haptics.failed();
      setError(result.error ?? "Couldn't create the goal");
    }
    // Runs once per answer. The callbacks it reaches are recreated every render
    // and `onCreated` comes from the parent; listing them would replay the
    // outcome (alert, navigation) on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // The system file picker. Files join the goal's context row as chips and
  // are sent with the goal; the same per-message limits as attachments apply.
  const pickPhone = useCallback(async () => {
    const outcome = await pickFiles(MAX_ATTACHMENTS - files.length);
    if (outcome.status === "picked") {
      const next = addAttachments(files, outcome.attachments);
      if (next.rejected) {
        haptics.warned();
        setError(next.rejected);
      } else {
        haptics.select();
        setError(undefined);
        setFiles(next.attachments);
      }
    } else if (outcome.status === "denied" || outcome.status === "error") {
      setError(outcome.message);
    }
  }, [files]);

  const ready = name.trim().length > 0 && goal.trim().length > 0 && pending === undefined;
  const index = STEPS.indexOf(step);
  // Name and goal are required; the rest can be skipped with Next.
  const canNext = step === "name" ? name.trim().length > 0 : step === "goal" ? goal.trim().length > 0 : true;

  const go = (to: number) => {
    const next = STEPS[Math.max(0, Math.min(STEPS.length - 1, to))]!;
    if (next === step) return;
    haptics.select();
    setStep(next);
  };

  const launch = () => {
    if (!ready) {
      abortLaunch();
      return;
    }
    setError(undefined);
    // Recorded before the reply can arrive.
    sentFiles.current = files.length;
    const id = onCreate({
      name: name.trim(),
      goal: goal.trim(),
      context,
      instructions: instructions.trim() || undefined,
      ...(files.length > 0 ? { files: toWireAttachments(files) } : {}),
    });
    if (id) {
      answered.current = false;
      setPending(id);
      // Still waiting after the blast has had its moment: say so on the cover
      // (only if no answer has come by then; see `answered`).
      later(BURST_MIN_S * 1000 + 900, () => {
        if (!answered.current) setWaitingLong(true);
      });
    } else {
      abortLaunch();
      haptics.failed();
      setError("Not connected to your computer");
    }
  };

  /** The charge completed (the blast already started on the UI thread). */
  const fire = () => {
    sounds.play("burst");
    haptics.attention();
    later(90, haptics.sent);
    firedAt.current = Date.now();
    launchedRef.current = true;
    setLaunched(true);
    launch();
  };

  // The wizard under the blast: gone the moment it starts (the cover is
  // already opaque), back as a launch called off fades.
  //
  // Not on the blast's very first frame: the canvas paints its cover a frame
  // after the value flips, and hiding the wizard on the flip showed whatever
  // was behind the sheet (another conversation) for that one frame.
  const wizardStyle = useAnimatedStyle(() => ({ opacity: fx.burst.value < COVER_LAG_S ? 1 : 1 - fx.fade.value }));

  // Ken's mood follows the step: listening while you write, happy at the end.
  const kenMood = step === "goal" ? "thinking" : "idle";

  return (
    <View style={styles.fill}>
    <Reanimated.View style={[styles.screen, { paddingTop: insets.top }, wizardStyle]} pointerEvents={launched ? "none" : "auto"}>
      {/* Back and Next live up here, not under the field: the steps open the
          keyboard themselves, and a row along the bottom sat under it, so
          every step meant closing the keyboard to reach the next one. */}
      <View style={styles.bar}>
        <View style={styles.barSide}>
          <CircleButton label="Close new goal" size={40} onPress={onClose}>
            <DotGlyph name="close" size={14} />
          </CircleButton>
          {index > 0 && (
            <Reanimated.View entering={reduce ? undefined : FadeIn.duration(DUR.enter)} exiting={reduce ? undefined : FadeOut.duration(DUR.exit)}>
              <CircleButton label="Back" size={40} feel={() => undefined} onPress={() => go(index - 1)}>
                <DotGlyph name="back" size={16} />
              </CircleButton>
            </Reanimated.View>
          )}
        </View>
        <View style={styles.progress} accessibilityLabel={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <View key={s} style={[styles.progressDot, i <= index && styles.progressDotOn, i === index && styles.progressDotNow]} />
          ))}
        </View>
        <View style={[styles.barSide, styles.barSideEnd]}>
          {step !== "launch" && (
            <StageButton
              compact
              color={KEN_COLOR}
              style={styles.next}
              disabled={!canNext}
              label={(step === "context" && context.length === 0 && files.length === 0) || (step === "instructions" && !instructions.trim()) ? "Skip" : "Next"}
              feel="none"
              onPress={() => go(index + 1)}
            />
          )}
        </View>
      </View>

      {step === "launch" ? (
        // Not in the scroll view: the hold area is most of the screen, and
        // the blast is drawn from where Ken sits, so he must not move.
        <View style={[styles.fill, { paddingBottom: insets.bottom + theme.space(4) }]}>
          <Reanimated.View entering={reduce ? undefined : FadeInDown.duration(260)} style={styles.launchHead}>
            <Text style={styles.stepTitle} accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {STEP_TITLE.launch}
            </Text>
            {error ? (
              <Text style={[styles.error, styles.errorCentred]} accessibilityLiveRegion="polite">
                {error}
              </Text>
            ) : null}
          </Reanimated.View>
          <LaunchPad ready={ready} pending={pending !== undefined} plain={plain} fx={fx} onFire={fire} onLaunch={launch} onScene={setScene} />
        </View>
      ) : (
      <KeyboardAwareScrollView
        style={styles.fill}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + theme.space(8) }]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={theme.space(6)}
      >
        {/* Ken stays put across steps (not keyed): only the step below changes. */}
        <View style={styles.ken}>
          <Pew size={112} mood={kenMood} color={KEN_COLOR} accessibilityLabel="Ken" />
        </View>
        <Reanimated.View
          key={step}
          entering={reduce ? undefined : FadeInDown.duration(260)}
          style={styles.step}
        >
          <Text style={styles.stepTitle} accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {STEP_TITLE[step]}
          </Text>

          {step === "name" && (
            <>
              <StageInput
                style={styles.center}
                value={name}
                onChangeText={setName}
                maxLength={NAME_MAX}
                placeholder="Checkout speed"
                returnKeyType="next"
                autoFocus={process.env.EXPO_PUBLIC_DEV_NO_FOCUS !== "1"}
                onSubmitEditing={() => canNext && go(index + 1)}
              />
              <Led tone="dim">{`${name.length}/${NAME_MAX}`}</Led>
            </>
          )}

          {step === "goal" && (
            <StageInput
              style={styles.goal}
              value={goal}
              onChangeText={setGoal}
              maxLength={GOAL_MAX}
              placeholder="Get checkout loading under one second on mobile"
              multiline
              autoFocus={process.env.EXPO_PUBLIC_DEV_NO_FOCUS !== "1"}
            />
          )}

          {step === "context" && (
            <View style={styles.wide}>
              <ContextChips
                chosen={context}
                onChange={setContext}
                phoneFiles={files}
                onRemovePhoneFile={(id) => setFiles((now) => now.filter((f) => f.id !== id))}
              />
              {/* Moves down (or up) with the same spring when a chip row
                  appears or grows, instead of jumping. */}
              {visible && (
                <Reanimated.View layout={reduce ? undefined : CHIP_LAYOUT}>
                  <FolderPicker
                    chosen={context}
                    onChange={(next) => setContext(next.slice(0, CONTEXT_MAX - files.length))}
                    browse={browse}
                    onBrowse={onBrowse}
                    online={online}
                    allowFiles
                    hideChosen
                    onPickPhoneFiles={() => void pickPhone()}
                  />
                </Reanimated.View>
              )}
            </View>
          )}

          {step === "instructions" && (
            <StageInput
              style={styles.multi}
              value={instructions}
              onChangeText={setInstructions}
              maxLength={INSTRUCTIONS_MAX}
              placeholder={INSTRUCTIONS_PLACEHOLDER}
              multiline
              autoFocus={process.env.EXPO_PUBLIC_DEV_NO_FOCUS !== "1"}
            />
          )}

          {error ? (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
        </Reanimated.View>
      </KeyboardAwareScrollView>
      )}
    </Reanimated.View>
    {step === "launch" && scene && !plain && <LaunchFx scene={scene} color={KEN_COLOR} values={fx} />}
    {launched && waitingLong && (
      <Reanimated.View style={styles.launching} pointerEvents="none" entering={FadeIn.duration(DUR.dissolve)} exiting={FadeOut.duration(DUR.exit)}>
        <Led tone="agent" color={KEN_COLOR}>Launching</Led>
      </Reanimated.View>
    )}
    </View>
  );
}

export const NAME_MAX = 15;
export const GOAL_MAX = 2000;
export const CONTEXT_MAX = 20;
export const INSTRUCTIONS_MAX = 4000;
export const INSTRUCTIONS_PLACEHOLDER = "Keep the current design. Ask before adding dependencies.";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Led tone="dim">{label}</Led>
      {hint ? <Text style={styles.hint} numberOfLines={2}>{hint}</Text> : null}
      {children}
    </View>
  );
}

/** Text input on the surface with the composer border; focus lights it GG Goals purple. */
export function StageInput(props: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={theme.composer.placeholder}
      {...props}
      editable={props.editable}
      style={[styles.input, focused && styles.inputFocused, props.editable === false && styles.inputOff, props.style]}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}

/** Chosen context (folders and files) as dashed chips; tap × to remove. */
export function ContextChips({
  chosen,
  onChange,
  disabled,
  phoneFiles = [],
  onRemovePhoneFile,
}: {
  chosen: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Files picked on this phone, shown in the same row (sent with the goal). */
  phoneFiles?: readonly PendingAttachment[];
  onRemovePhoneFile?: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  if (chosen.length === 0 && phoneFiles.length === 0) return null;
  return (
    // Each chip springs in where it lands and shrinks away when removed; the
    // others slide to close the gap. The row's own height change is animated
    // by the caller's layout transition, so what's under it glides too.
    <Reanimated.View
      style={styles.chips}
      entering={reduce ? undefined : FadeIn.duration(180)}
      exiting={reduce ? undefined : FadeOut.duration(160)}
      layout={reduce ? undefined : CHIP_LAYOUT}
    >
      {chosen.map((path) => (
        <Reanimated.View
          key={path}
          style={[styles.chip, dashedOutline]}
          entering={reduce ? undefined : ZoomIn.duration(SPRING.arrive.duration).easing(EASE_OUT)}
          exiting={reduce ? undefined : ZoomOut.duration(160)}
          layout={reduce ? undefined : CHIP_LAYOUT}
        >
          <Text style={styles.chipText} numberOfLines={1}>{path.split("/").filter(Boolean).pop() ?? path}</Text>
          {disabled ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${path}`}
              hitSlop={10}
              onPress={() => {
                haptics.tap();
                onChange(chosen.filter((entry) => entry !== path));
              }}
            >
              <Ionicons name="close" size={13} color={theme.color.textDim} />
            </Pressable>
          )}
        </Reanimated.View>
      ))}
      {phoneFiles.map((file) => (
        <Reanimated.View
          key={file.id}
          style={[styles.chip, dashedOutline]}
          entering={reduce ? undefined : ZoomIn.duration(SPRING.arrive.duration).easing(EASE_OUT)}
          exiting={reduce ? undefined : ZoomOut.duration(160)}
          layout={reduce ? undefined : CHIP_LAYOUT}
        >
          <Ionicons name="phone-portrait-outline" size={12} color={theme.color.textDim} />
          <Text style={styles.chipText} numberOfLines={1}>{file.name}</Text>
          {disabled || !onRemovePhoneFile ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${file.name}`}
              hitSlop={10}
              onPress={() => {
                haptics.tap();
                onRemovePhoneFile(file.id);
              }}
            >
              <Ionicons name="close" size={13} color={theme.color.textDim} />
            </Pressable>
          )}
        </Reanimated.View>
      ))}
    </Reanimated.View>
  );
}

/** One spring for everything that moves to make room (chips, the list below). */
export const CHIP_LAYOUT = LinearTransition.duration(SPRING.settle.duration).easing(EASE_OUT);

/** True when the user wants motion off or uses a screen reader: offer a plain button instead of hold. */
function usePlainLaunch(): boolean {
  const reduce = useReducedMotion();
  const [reader, setReader] = useState(false);
  useEffect(() => {
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", setReader);
    void AccessibilityInfo.isScreenReaderEnabled().then(setReader);
    return () => sub.remove();
  }, []);
  return reduce || reader;
}

/** How long into the blast the canvas has certainly painted its cover. */
const COVER_LAG_S = 0.07;
/** A full hold, start to blast. Long enough to feel the build. */
const HOLD_MS = 1600;
/** The opening onto the session. */
const REVEAL_MS = 900;
/** A beat for the goal's session to mount behind the cover before it opens. */
const SESSION_MOUNT_MS = 260;
const KEN_SIZE = 180;
/** The globe fills about 60% of Pew's box. */
const KEN_RADIUS = KEN_SIZE * 0.3;
const RING_BOX = Math.ceil(KEN_RADIUS * RING_SCALE * 2 + 48);

/**
 * The launch step's hold area: everything under the title. Hold anywhere and
 * Ken charges (the ring of dots and the streaming particles are LaunchFx's,
 * drawn round where he sits); let go early and it drains; hold to the end and
 * he blows. With Reduce Motion or a screen reader it is a plain button.
 */
function LaunchPad({ ready, pending, plain, fx, onFire, onLaunch, onScene }: {
  ready: boolean;
  pending: boolean;
  plain: boolean;
  fx: LaunchFxValues;
  onFire: () => void;
  onLaunch: () => void;
  onScene: (scene: FxScene) => void;
}) {
  const [holding, setHolding] = useState(false);
  const ken = useRef<View>(null);
  // Loaded as the step opens, so the first hold is not a beat late.
  useEffect(() => sounds.preload(["charge", "drain", "burst", "reveal"]), []);
  const { width, height } = useWindowDimensions();
  const measure = useCallback(() => {
    ken.current?.measureInWindow((x, y, w, h) => {
      if (w > 0) onScene({ w: width, h: height, cx: x + w / 2, cy: y + h / 2, kenR: KEN_RADIUS });
    });
  }, [width, height, onScene]);
  useEffect(() => {
    if (!pending) setHolding(false);
  }, [pending]);

  // Haptics climb with the charge: sparse soft taps, then every other dot,
  // then a rigid tick on every dot in the last stretch.
  const felt = useCallback((n: number) => {
    if (n >= RING_DOTS) return;
    if (n >= 17) haptics.detent();
    else if (n >= 9 ? n % 2 === 0 : n % 4 === 0) haptics.poke();
  }, []);
  useAnimatedReaction(
    () => Math.floor(fx.charge.value * RING_DOTS),
    (now, prev) => {
      if (prev !== null && now > prev && fx.burst.value < 0) runOnJS(felt)(now);
    },
    [felt],
  );

  const press = () => {
    if (plain || pending || fx.burst.value >= 0) return;
    if (!ready) {
      haptics.warned();
      return;
    }
    measure();
    setHolding(true);
    haptics.tap();
    if (!plain) sounds.charge(fx.charge.value, HOLD_MS);
    const { charge, burst } = fx;
    charge.value = withTiming(1, { duration: HOLD_MS * (1 - charge.value), easing: Easing.linear }, (done) => {
      if (!done) return;
      // The blast starts here, on the UI thread, on the very frame the charge
      // completes; React hears about it after.
      burst.value = 0;
      runOnJS(onFire)();
    });
  };
  const release = () => {
    if (plain || fx.burst.value >= 0) return;
    setHolding(false);
    if (fx.charge.value > 0.02) {
      sounds.stop("charge", 60);
      sounds.play("drain");
    }
    cancelAnimation(fx.charge);
    fx.charge.value = withTiming(0, { duration: DUR.dissolve, easing: EASE_OUT });
  };

  // `EXPO_PUBLIC_DEV_LAUNCH_DEMO=1` (development only): holds Ken by itself
  // a moment after the step opens, for recording the launch on a simulator,
  // which cannot hold a finger down.
  useEffect(() => {
    if (!__DEV__ || process.env.EXPO_PUBLIC_DEV_LAUNCH_DEMO !== "1" || !ready || !onScene) return;
    const t = setTimeout(press, 2500);
    return () => clearTimeout(t);
    // Dev-only demo, armed once when the step is ready: `press` is recreated
    // every render and would reset the 2.5s timer on each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const kenStyle = useAnimatedStyle(() => {
    const c = fx.charge.value;
    const t = fx.clock.value;
    return {
      opacity: fx.burst.value >= COVER_LAG_S ? 0 : 1,
      transform: [{ translateX: fxShake(t, c) }, { translateY: fxShake(t + 0.37, c) * 0.6 }, { scale: fxKenScale(c) }],
    };
  });

  const caption = pending ? "Launching" : ready ? (holding ? "Keep holding" : "Hold anywhere here") : "Name and goal first";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Hold to launch goal"
      accessibilityState={{ disabled: !ready }}
      onPressIn={press}
      onPressOut={release}
      style={[styles.pad, !ready && !pending && styles.padOff]}
    >
      <View style={styles.ring}>
        <Reanimated.View style={kenStyle}>
          <View ref={ken} collapsable={false} onLayout={measure}>
            <Pew size={KEN_SIZE} mood={holding || pending ? "working" : "happy"} color={KEN_COLOR} accessibilityLabel="Ken" />
          </View>
        </Reanimated.View>
      </View>
      <Led tone={ready ? "agent" : "dim"} color={ready ? KEN_COLOR : undefined} numberOfLines={1}>{caption}</Led>
      {plain && (
        <StageButton color={KEN_COLOR} disabled={!ready} feel="sent" label={pending ? "Launching…" : "Launch goal"} onPress={onLaunch} />
      )}
    </Pressable>
  );
}

/** Close + Back on the left, Next on the right. */
const BAR_SIDE = 40 + theme.space(2) + 40;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.color.bg },
  bar: { flexDirection: "row", alignItems: "center", gap: theme.space(3), paddingHorizontal: theme.gutter, paddingVertical: theme.space(2) },
  // Both sides one width, so the progress dots stay centred whichever
  // buttons are showing.
  barSide: { width: BAR_SIDE, flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  barSideEnd: { justifyContent: "flex-end" },
  next: { minWidth: BAR_SIDE - theme.space(2), paddingHorizontal: theme.space(4) },
  progress: { flex: 1, flexDirection: "row", justifyContent: "center", gap: theme.space(1.5) },
  progressDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.stage.dash },
  progressDotOn: { backgroundColor: KEN_COLOR },
  progressDotNow: { width: 18 },
  // Centred column: Ken, then the step's title, then its one field.
  body: { flexGrow: 1, alignItems: "center", paddingHorizontal: theme.gutter, paddingTop: theme.space(6), paddingBottom: theme.space(8) },
  ken: { alignItems: "center", marginBottom: theme.space(2) },
  step: { alignSelf: "stretch", alignItems: "center", gap: theme.space(3) },
  stepTitle: { color: theme.color.text, fontFamily: theme.display.regular, fontSize: 24, lineHeight: 30, textAlign: "center" },
  center: { alignSelf: "stretch", textAlign: "center", fontSize: 18 },
  wide: { alignSelf: "stretch", gap: theme.space(3) },
  goal: { alignSelf: "stretch", minHeight: 140, textAlignVertical: "top" },
  multi: { alignSelf: "stretch", minHeight: 120, textAlignVertical: "top" },
  field: { gap: theme.space(2) },
  hint: { color: theme.color.textDim, fontSize: theme.font.small },
  input: {
    minHeight: theme.size.touch,
    borderRadius: theme.composer.radius,
    borderWidth: 1,
    borderColor: theme.composer.border,
    backgroundColor: theme.composer.fill,
    color: theme.color.text,
    fontSize: theme.font.body,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
  },
  inputFocused: { borderColor: KEN_COLOR },
  inputOff: { opacity: 0.5 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  chip: { flexDirection: "row", alignItems: "center", gap: theme.space(1.5), maxWidth: "100%", paddingHorizontal: theme.space(3), paddingVertical: theme.space(1.5), borderRadius: theme.radius.pill },
  chipText: { flexShrink: 1, color: theme.color.text, fontSize: theme.font.small },
  error: { color: theme.color.danger, fontSize: theme.font.small },
  errorCentred: { textAlign: "center", alignSelf: "stretch", lineHeight: 20 },
  // The hold area: everything under the title, so a thumb can't miss it.
  pad: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center", gap: theme.space(4) },
  padOff: { opacity: 0.45 },
  ring: { width: RING_BOX, height: RING_BOX, alignItems: "center", justifyContent: "center" },
  launchHead: { alignItems: "center", gap: theme.space(2), paddingHorizontal: theme.gutter, paddingTop: theme.space(6) },
  launching: { position: "absolute", left: 0, right: 0, bottom: theme.space(24), alignItems: "center" },
  pressed: { opacity: 0.7 },
});

export const NewGoalSheet = memo(NewGoalSheetView);
