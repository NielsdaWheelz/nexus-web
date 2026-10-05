export const PLAYBACK_RATE_MIN = 0.5;
export const PLAYBACK_RATE_MAX = 3;
export const PLAYBACK_RATE_STEP = 0.05;
export const PLAYBACK_RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2] as const;

export type PauseShorteningMode = "Off" | "Natural";

// Rates are compared and stepped in whole hundredths, so 0.05 steps never drift.
const hundredths = (rate: number) => Math.round(rate * 100);
const clamp = (h: number) =>
  Math.min(
    hundredths(PLAYBACK_RATE_MAX),
    Math.max(hundredths(PLAYBACK_RATE_MIN), h),
  ) / 100;

/** "1.5x", "2x", "0.75x". */
export function formatPlaybackRate(rate: number): string {
  return `${(hundredths(rate) / 100).toFixed(2).replace(/\.?0+$/, "")}x`;
}

export function stepPlaybackRate(rate: number, direction: -1 | 1): number {
  return clamp(hundredths(rate) + direction * hundredths(PLAYBACK_RATE_STEP));
}

export function snapPlaybackRate(rate: number): number {
  const step = hundredths(PLAYBACK_RATE_STEP);
  const min = hundredths(PLAYBACK_RATE_MIN);
  return clamp(min + Math.round((hundredths(rate) - min) / step) * step);
}
