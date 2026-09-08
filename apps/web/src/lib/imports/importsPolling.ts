/**
 * When the Imports pane should read the summary again, and when it should stop.
 * The provider owns the timer, the wake signals and the `justify-polling`; this
 * owns the decision, so every edge of the schedule is provable without one.
 */

const POLL_INTERVAL_MS = 5_000;
const CLOSED_PANE_WINDOW_MS = 15 * 60_000;

export type ImportsObservation =
  | { readonly kind: "Poll"; readonly delayMs: number }
  | { readonly kind: "Stopped" };

export function nextObservation({
  lastWakeAtMs,
  nowMs,
  activeCount,
  documentVisible,
  paneOpen,
}: {
  readonly lastWakeAtMs: number;
  readonly nowMs: number;
  readonly activeCount: number;
  readonly documentVisible: boolean;
  readonly paneOpen: boolean;
}): ImportsObservation {
  if (activeCount === 0 || !documentVisible) return { kind: "Stopped" };
  if (!paneOpen && nowMs - lastWakeAtMs >= CLOSED_PANE_WINDOW_MS) {
    return { kind: "Stopped" };
  }
  return { kind: "Poll", delayMs: POLL_INTERVAL_MS };
}
