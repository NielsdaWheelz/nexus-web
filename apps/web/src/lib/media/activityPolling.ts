export interface MediaActivityPollingSchedule {
  readonly pollIntervalMs: number;
  readonly expiresAtMs: number;
}

/** The one schedule shape for one visible Activity opening. */
export function mediaActivityPollingSchedule(
  openedAtMs: number,
): MediaActivityPollingSchedule {
  return {
    pollIntervalMs: 5_000,
    expiresAtMs: openedAtMs + 15 * 60_000,
  };
}

export function mediaActivityPollingExpired(
  schedule: MediaActivityPollingSchedule,
  nowMs: number,
): boolean {
  return nowMs >= schedule.expiresAtMs;
}
