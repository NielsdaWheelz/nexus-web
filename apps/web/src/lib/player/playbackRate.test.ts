import { describe, expect, it } from "vitest";
import {
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  adjustedRemainingMs,
  formatPlaybackRate,
  isPlaybackRateStepAligned,
  parsePlaybackRate,
  snapPlaybackRateToStep,
  stepPlaybackRate,
} from "@/lib/player/playbackRate";

describe("playbackRate", () => {
  it("strictly accepts only finite product-range rates", () => {
    expect(parsePlaybackRate(PLAYBACK_RATE_MIN)).toBe(0.5);
    expect(parsePlaybackRate(PLAYBACK_RATE_MAX)).toBe(3);
    for (const value of [0.499, 3.001, Number.NaN, Infinity, "1.5", null]) {
      expect(() => parsePlaybackRate(value)).toThrow();
    }
  });

  it("formats arbitrary valid values without floating-point noise", () => {
    expect(formatPlaybackRate(1)).toBe("1x");
    expect(formatPlaybackRate(1.5)).toBe("1.5x");
    expect(formatPlaybackRate(1.8499999999999999)).toBe("1.85x");
  });

  it("steps in integer hundredths and clamps only the user step at bounds", () => {
    expect(stepPlaybackRate(1.8, 1)).toBe(1.85);
    expect(stepPlaybackRate(1.85, -1)).toBe(1.8);
    expect(stepPlaybackRate(0.5, -1)).toBe(0.5);
    expect(stepPlaybackRate(3, 1)).toBe(3);
  });

  it("detects off-grid canonical rates and snaps direct range edits", () => {
    expect(isPlaybackRateStepAligned(1.85)).toBe(true);
    expect(isPlaybackRateStepAligned(1.83)).toBe(false);
    expect(snapPlaybackRateToStep(2.02)).toBe(2);
    expect(snapPlaybackRateToStep(2.03)).toBe(2.05);
  });

  it("derives approximate adjusted remaining time from source time and base rate", () => {
    expect(adjustedRemainingMs(120_000, 30_000, 1.5)).toBe(60_000);
    expect(adjustedRemainingMs(10, 0, 3)).toBe(4);
    expect(adjustedRemainingMs(100, 120, 2)).toBe(0);
  });
});
