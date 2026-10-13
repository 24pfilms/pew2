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
import { AccessibilityInfo, Alert, Modal, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import Reanimated, { FadeIn, FadeInDown, FadeOut, LinearTransition, ZoomIn, ZoomOut, useReducedMotion } from "react-native-reanimated";
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
import { SPRING } from "../motion";
import { addAttachments, MAX_ATTACHMENTS, toWireAttachments, type PendingAttachment, type WireAttachment } from "../attachments";
import { pickFiles } from "./attachmentPicker";

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
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="fullScreen"
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
              <NewGoalScreen {...props} />
            </AgentColorProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** The steps, in order. The last one is launching. */
const STEPS = ["name", "goal", "context", "instructions", "launch"] as const;
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
 * company; each step is just a title and its field, no descriptions. Next /
 * Back move between steps; the last one is the launch pad.
 */
function NewGoalScreen({ visible, onClose, onCreate, results, onCreated, browse, onBrowse, prefill, online }: NewGoalSheetProps) {
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

  useEffect(() => {
    if (!visible) return;
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
  }, [visible, prefill]);

  const result = pending ? results[pending] : undefined;
  // How many phone files went out with the create, to check they arrived.
  const sentFiles = useRef(0);
  useEffect(() => {
    if (!result) return;
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
      onCreated(result.goal);
    } else setError(result.error ?? "Couldn't create the goal");
  }, [result, onCreated]);

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
    if (!ready) return;
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
    if (id) setPending(id);
    else setError("Not connected to your computer");
  };

  // Ken's mood follows the step: listening while you write, happy at the end.
  const kenMood = pending ? "happy" : step === "launch" ? "happy" : step === "goal" ? "thinking" : "idle";

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <CircleButton label="Close new goal" size={40} onPress={onClose}>
          <DotGlyph name="close" size={14} />
        </CircleButton>
        <View style={styles.progress} accessibilityLabel={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <View key={s} style={[styles.progressDot, i <= index && styles.progressDotOn, i === index && styles.progressDotNow]} />
          ))}
        </View>
        <View style={styles.barSpacer} />
      </View>

      <KeyboardAwareScrollView
        style={styles.fill}
        // The launch step is only Ken's pad: centred in the screen rather than
        // hanging from the top like the steps that hold a field.
        contentContainerStyle={[styles.body, step === "launch" && styles.bodyCentred]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={theme.space(6)}
      >
        {/* Ken stays put across steps (not keyed): only the step below changes. */}
        {step !== "launch" && (
          <View style={styles.ken}>
            <Pew size={112} mood={kenMood} color={KEN_COLOR} accessibilityLabel="Ken" />
          </View>
        )}
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

          {step === "launch" && <LaunchPad ready={ready} pending={pending !== undefined} onLaunch={launch} />}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </Reanimated.View>
      </KeyboardAwareScrollView>

      <View style={[styles.nav, { paddingBottom: insets.bottom + theme.space(3) }]}>
        {index > 0 ? (
          <StageButton compact kind="secondary" style={styles.navBtn} label="Back" feel="none" onPress={() => go(index - 1)} />
        ) : (
          <View style={styles.navBtn} />
        )}
        {step !== "launch" ? (
          <StageButton
            compact
            color={KEN_COLOR}
            style={styles.navBtn}
            disabled={!canNext}
            label={(step === "context" && context.length === 0) || (step === "instructions" && !instructions.trim()) ? "Skip" : "Next"}
            feel="none"
            onPress={() => go(index + 1)}
          />
        ) : (
          <View style={styles.navBtn} />
        )}
      </View>
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

const DOTS = 16;
const HOLD_MS = 1200;
const RING = 132;

/** A ring of dots around Ken's Pew: hold to fill it dot by dot, release early to drain. */
function LaunchPad({ ready, pending, onLaunch }: { ready: boolean; pending: boolean; onLaunch: () => void }) {
  const plain = usePlainLaunch();
  const [lit, setLit] = useState(0);
  const [holding, setHolding] = useState(false);
  const [launched, setLaunched] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = undefined;
  };
  useEffect(() => stop, []);
  useEffect(() => {
    if (!pending) setLaunched(false);
  }, [pending]);

  const press = () => {
    if (!ready) {
      haptics.warned();
      return;
    }
    stop();
    setHolding(true);
    timer.current = setInterval(() => {
      setLit((n) => {
        const next = Math.min(DOTS, n + 1);
        if (next === DOTS) {
          stop();
          setHolding(false);
          haptics.sent();
          setLaunched(true);
          // Commit outside the updater (an updater may run twice).
          setTimeout(() => {
            onLaunch();
            setLit(0);
          }, 0);
        } else if (next % 4 === 0) haptics.detent();
        return next;
      });
    }, HOLD_MS / DOTS);
  };
  const release = () => {
    if (!timer.current) return;
    stop();
    setHolding(false);
    timer.current = setInterval(() => {
      setLit((n) => {
        if (n <= 1) stop();
        return Math.max(0, n - 1);
      });
    }, 30);
  };

  const mood = launched || pending ? "happy" : holding ? "working" : "idle";
  // The step's title already says "Hold Ken to launch"; this only reports state.
  const caption = pending ? "Launching" : ready ? (holding ? "Keep holding" : "Ready") : "Name and goal first";
  return (
    <View style={[styles.pad, !ready && !pending && styles.padOff]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hold to launch goal"
        accessibilityState={{ disabled: !ready }}
        onPressIn={press}
        onPressOut={release}
        style={styles.ring}
      >
        {Array.from({ length: DOTS }, (_, i) => {
          const a = (i / DOTS) * Math.PI * 2 - Math.PI / 2;
          const r = RING / 2 - 4;
          return (
            <View
              key={i}
              style={[
                styles.dot,
                { left: RING / 2 - 3 + r * Math.cos(a), top: RING / 2 - 3 + r * Math.sin(a) },
                i < lit && styles.dotOn,
              ]}
            />
          );
        })}
        <Pew size={88} mood={mood} color={KEN_COLOR} accessibilityLabel="Ken" />
      </Pressable>
      <Led tone={ready ? "agent" : "dim"} color={ready ? KEN_COLOR : undefined} numberOfLines={1}>{caption}</Led>
      {plain && (
        <StageButton color={KEN_COLOR} disabled={!ready} feel="sent" label={pending ? "Launching…" : "Launch goal"} onPress={onLaunch} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { flex: 1, backgroundColor: theme.color.bg },
  bar: { flexDirection: "row", alignItems: "center", gap: theme.space(3), paddingHorizontal: theme.gutter, paddingVertical: theme.space(2) },
  barSpacer: { width: 40 },
  progress: { flex: 1, flexDirection: "row", justifyContent: "center", gap: theme.space(1.5) },
  progressDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.stage.dash },
  progressDotOn: { backgroundColor: KEN_COLOR },
  progressDotNow: { width: 18 },
  // Centred column: Ken, then the step's title, then its one field.
  body: { flexGrow: 1, alignItems: "center", paddingHorizontal: theme.gutter, paddingTop: theme.space(6), paddingBottom: theme.space(8) },
  bodyCentred: { justifyContent: "center", paddingTop: 0 },
  ken: { alignItems: "center", marginBottom: theme.space(2) },
  step: { alignSelf: "stretch", alignItems: "center", gap: theme.space(3) },
  stepTitle: { color: theme.color.text, fontFamily: theme.display.regular, fontSize: 24, lineHeight: 30, textAlign: "center" },
  center: { alignSelf: "stretch", textAlign: "center", fontSize: 18 },
  wide: { alignSelf: "stretch", gap: theme.space(3) },
  goal: { alignSelf: "stretch", minHeight: 140, textAlignVertical: "top" },
  multi: { alignSelf: "stretch", minHeight: 120, textAlignVertical: "top" },
  nav: { flexDirection: "row", gap: theme.space(3), paddingHorizontal: theme.gutter, paddingTop: theme.space(3) },
  navBtn: { flex: 1 },
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
  pad: { alignItems: "center", gap: theme.space(3), paddingTop: theme.space(4) },
  padOff: { opacity: 0.45 },
  ring: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
  dot: { position: "absolute", width: 6, height: 6, borderRadius: 3, backgroundColor: theme.stage.dash },
  dotOn: { backgroundColor: KEN_COLOR },
  pressed: { opacity: 0.7 },
});

export const NewGoalSheet = memo(NewGoalSheetView);
