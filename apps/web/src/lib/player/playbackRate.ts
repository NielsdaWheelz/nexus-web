export const PLAYBACK_RATE_MIN = 0.5;
export const PLAYBACK_RATE_MAX = 3;
export const PLAYBACK_RATE_STEP = 0.05;
export const PLAYBACK_RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2] as const;

export function parsePlaybackRate(
  value: unknown,
  context = "playback rate",
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < PLAYBACK_RATE_MIN ||
    value > PLAYBACK_RATE_MAX
  ) {
    throw new Error(
      `Invalid ${context}: expected a finite number in ${PLAYBACK_RATE_MIN}..${PLAYBACK_RATE_MAX}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function formatPlaybackRate(rate: number): string {
  return `${(Math.round(parsePlaybackRate(rate) * 100) / 100)
    .toFixed(2)
    .replace(/\.?0+$/, "")}x`;
}

export function stepPlaybackRate(
  rate: number,
  direction: -1 | 1,
): number {
  const nextHundredths =
    Math.round(parsePlaybackRate(rate) * 100) +
    direction * Math.round(PLAYBACK_RATE_STEP * 100);
  return (
    Math.min(
      Math.round(PLAYBACK_RATE_MAX * 100),
      Math.max(Math.round(PLAYBACK_RATE_MIN * 100), nextHundredths),
    ) / 100
  );
}

export function isPlaybackRateStepAligned(rate: number): boolean {
  const hundredths = Math.round(parsePlaybackRate(rate) * 100);
  const minHundredths = Math.round(PLAYBACK_RATE_MIN * 100);
  const stepHundredths = Math.round(PLAYBACK_RATE_STEP * 100);
  return (hundredths - minHundredths) % stepHundredths === 0;
}

export function snapPlaybackRateToStep(rate: number): number {
  const hundredths = Math.round(parsePlaybackRate(rate) * 100);
  const minHundredths = Math.round(PLAYBACK_RATE_MIN * 100);
  const maxHundredths = Math.round(PLAYBACK_RATE_MAX * 100);
  const stepHundredths = Math.round(PLAYBACK_RATE_STEP * 100);
  const snappedHundredths =
    minHundredths +
    Math.round((hundredths - minHundredths) / stepHundredths) *
      stepHundredths;
  return (
    Math.min(
      maxHundredths,
      Math.max(minHundredths, snappedHundredths),
    ) / 100
  );
}

export function adjustedRemainingMs(
  durationMs: number,
  positionMs: number,
  baseRate: number,
): number {
  if (
    !Number.isFinite(durationMs) ||
    !Number.isFinite(positionMs) ||
    durationMs < 0 ||
    positionMs < 0
  ) {
    throw new Error("Playback duration and position must be non-negative.");
  }
  return Math.max(
    0,
    Math.ceil((durationMs - positionMs) / parsePlaybackRate(baseRate)),
  );
}
