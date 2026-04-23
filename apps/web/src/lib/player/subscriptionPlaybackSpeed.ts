export const SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

export type SubscriptionPlaybackSpeedOption =
  (typeof SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS)[number];

export function formatPlaybackSpeedLabel(speed: number): string {
  const normalized = Number.isFinite(speed) ? speed : 1.0;
  const speedText = normalized % 1 === 0 ? normalized.toFixed(1) : String(normalized);
  return `${speedText}x`;
}

export function formatSubscriptionPlaybackSummary(
  defaultPlaybackSpeed: number | null | undefined,
  autoQueue: boolean | null | undefined
): string {
  return `${formatPlaybackSpeedLabel(defaultPlaybackSpeed ?? 1.0)} default speed · Auto-queue ${
    autoQueue ? "on" : "off"
  }`;
}
