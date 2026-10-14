/**
 * The Skia plumbing shared by everything that records a picture per frame on
 * the UI thread (Pew, the goal launch, the thinking dial).
 *
 * Why it exists: React Native Skia (2.2) files every Skia object a worklet
 * touches into one global table per runtime, and that table has no lock. An
 * object made on the JS thread, drawn on the UI thread and later garbage
 * collected on the JS thread is removed from the UI runtime's table *from the
 * JS thread*, while the UI thread is adding the objects of the next frame.
 * Two threads in one hash table: the app crashed in
 * `RuntimeLifecycleMonitor::addListener` (EXC_BAD_ACCESS on the main thread).
 *
 * So: the blank picture every painter starts from is made once and never
 * freed, and a frame reuses one recorder and one bounds rectangle instead of
 * making new ones, which also keeps the table from churning by hundreds of
 * entries a second.
 */
import { Skia, type SkCanvas, type SkPicture } from "@shopify/react-native-skia";

let blank: SkPicture | undefined;

/** The one blank picture a painter shows before its first frame. Never freed (see above). */
export function blankPicture(): SkPicture {
  if (!blank) {
    const recorder = Skia.PictureRecorder();
    recorder.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
    blank = recorder.finishRecordingAsPicture();
  }
  return blank;
}

interface FrameKit {
  recorder: ReturnType<typeof Skia.PictureRecorder>;
  rects: Record<string, ReturnType<typeof Skia.XYWHRect>>;
}

/** Start recording a w×h frame on the UI thread, with the runtime's one recorder. */
export function beginFrame(w: number, h: number): SkCanvas {
  "worklet";
  const g = globalThis as unknown as { __pewFrameKit?: FrameKit };
  if (!g.__pewFrameKit) g.__pewFrameKit = { recorder: Skia.PictureRecorder(), rects: {} };
  const kit = g.__pewFrameKit;
  const key = w + "x" + h;
  let rect = kit.rects[key];
  if (!rect) {
    rect = Skia.XYWHRect(0, 0, w, h);
    kit.rects[key] = rect;
  }
  return kit.recorder.beginRecording(rect);
}

/** Finish the frame `beginFrame` started. */
export function endFrame(): SkPicture {
  "worklet";
  const g = globalThis as unknown as { __pewFrameKit: FrameKit };
  return g.__pewFrameKit.recorder.finishRecordingAsPicture();
}
