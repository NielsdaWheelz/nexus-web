export interface MediaActivityPollingSchedule {
  readonly pollIntervalMs: number;
  readonly expiresAtMs: number;
}

const MEDIA_ACTIVITY_POLL_INTERVAL_MS = 5_000;
const MEDIA_ACTIVITY_POLL_WINDOW_MS = 15 * 60_000;

/** The one bounded schedule shape for a known-active Activity window. */
export function mediaActivityPollingSchedule(
  startedAtMs: number,
): MediaActivityPollingSchedule {
  return {
    pollIntervalMs: MEDIA_ACTIVITY_POLL_INTERVAL_MS,
    expiresAtMs: startedAtMs + MEDIA_ACTIVITY_POLL_WINDOW_MS,
  };
}

export function mediaActivityPollingExpired(
  schedule: MediaActivityPollingSchedule,
  nowMs: number,
): boolean {
  return nowMs >= schedule.expiresAtMs;
}
