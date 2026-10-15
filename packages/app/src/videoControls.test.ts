import { expect, test } from "bun:test";
import {
  DEFAULT_VIDEO_RATIO,
  formatClock,
  fractionToSeconds,
  progressFraction,
  SEEK_STEP_SECONDS,
  seekTarget,
  videoAspectRatio,
} from "./videoControls";

test("the clock reads minutes and seconds, and hours only when there are some", () => {
  expect(formatClock(0)).toBe("0:00");
  expect(formatClock(7.9)).toBe("0:07");
  expect(formatClock(65)).toBe("1:05");
  expect(formatClock(750)).toBe("12:30");
  expect(formatClock(3661)).toBe("1:01:01");
});

test("a clock that cannot be read shows zero rather than NaN", () => {
  expect(formatClock(NaN)).toBe("0:00");
  expect(formatClock(-3)).toBe("0:00");
  expect(formatClock(Infinity)).toBe("0:00");
});

test("skipping stays inside the video", () => {
  expect(SEEK_STEP_SECONDS).toBe(5);
  expect(seekTarget(12, 5, 30)).toBe(17);
  expect(seekTarget(12, -5, 30)).toBe(7);
  // Not before the start, not past the end.
  expect(seekTarget(2, -5, 30)).toBe(0);
  expect(seekTarget(28, 5, 30)).toBe(30);
  // Length not known yet: forward is allowed, backward still stops at zero.
  expect(seekTarget(10, 5, NaN)).toBe(15);
  expect(seekTarget(NaN, -5, 30)).toBe(0);
});

test("the progress bar fills from empty to full and never past it", () => {
  expect(progressFraction(0, 30)).toBe(0);
  expect(progressFraction(15, 30)).toBe(0.5);
  expect(progressFraction(31, 30)).toBe(1);
  expect(progressFraction(-1, 30)).toBe(0);
  expect(progressFraction(5, 0)).toBe(0);
  expect(progressFraction(5, NaN)).toBe(0);
});

test("a tap on the progress bar becomes a time", () => {
  expect(fractionToSeconds(0.5, 30)).toBe(15);
  expect(fractionToSeconds(0, 30)).toBe(0);
  expect(fractionToSeconds(1.4, 30)).toBe(30);
  expect(fractionToSeconds(-0.2, 30)).toBe(0);
  expect(fractionToSeconds(0.5, 0)).toBe(0);
});

test("a card takes the shape of its video: widescreen is wide, a phone clip is tall", () => {
  expect(videoAspectRatio(1920, 1080)).toBeCloseTo(16 / 9, 5);
  expect(videoAspectRatio(1080, 1920)).toBeCloseTo(9 / 16, 5);
  expect(videoAspectRatio(1000, 1000)).toBe(1);
  // Not known yet: drawn as a vertical clip, the common case.
  expect(videoAspectRatio(undefined, undefined)).toBe(DEFAULT_VIDEO_RATIO);
  expect(videoAspectRatio(0, 1080)).toBe(DEFAULT_VIDEO_RATIO);
  expect(videoAspectRatio(NaN, 1080)).toBe(DEFAULT_VIDEO_RATIO);
  // A strange file does not make a strip or a tower.
  expect(videoAspectRatio(5000, 100)).toBe(2.4);
  expect(videoAspectRatio(100, 5000)).toBe(0.4);
});
