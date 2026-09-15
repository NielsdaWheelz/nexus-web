import { describe, expect, it } from "vitest";
import { nextObservation } from "./importsPolling";

/**
 * Oracle: the observation schedule declared by the Imports cutover spec
 * ("Keep five-second observation while pane/document is visible and known work
 * active; bounded 15-minute observation when pane is closed, pause
 * hidden-document polling, stop on settled work") and contract D10. The
 * literals below come from that text, not from the module's constants.
 */
const WAKE_AT_MS = 1_700_000_000_000;
const FIVE_SECONDS_MS = 5_000;
const FIFTEEN_MINUTES_MS = 900_000;

const OPEN_AND_ACTIVE = {
  lastWakeAtMs: WAKE_AT_MS,
  nowMs: WAKE_AT_MS,
  activeCount: 1,
  documentVisible: true,
  paneOpen: true,
} as const;

describe("Imports observation schedule", () => {
  it("observes every five seconds while the pane is open, visible and working", () => {
    expect(nextObservation(OPEN_AND_ACTIVE)).toEqual({
      kind: "Poll",
      delayMs: FIVE_SECONDS_MS,
    });
  });

  it("keeps observing an open pane long after the closed-pane window would end", () => {
    expect(
      nextObservation({
        ...OPEN_AND_ACTIVE,
        nowMs: WAKE_AT_MS + FIFTEEN_MINUTES_MS * 4,
      }),
    ).toEqual({ kind: "Poll", delayMs: FIVE_SECONDS_MS });
  });

  it("stops once no work is active, however the pane and document stand", () => {
    for (const paneOpen of [true, false]) {
      expect(
        nextObservation({ ...OPEN_AND_ACTIVE, activeCount: 0, paneOpen }),
      ).toEqual({ kind: "Stopped" });
    }
  });

  it("pauses while the document is hidden", () => {
    for (const paneOpen of [true, false]) {
      expect(
        nextObservation({
          ...OPEN_AND_ACTIVE,
          documentVisible: false,
          paneOpen,
        }),
      ).toEqual({ kind: "Stopped" });
    }
  });

  it("observes a closed pane inside its window and stops at the exclusive edge", () => {
    const closed = { ...OPEN_AND_ACTIVE, paneOpen: false };

    expect(nextObservation(closed)).toEqual({
      kind: "Poll",
      delayMs: FIVE_SECONDS_MS,
    });
    expect(
      nextObservation({
        ...closed,
        nowMs: WAKE_AT_MS + FIFTEEN_MINUTES_MS - 1,
      }),
    ).toEqual({ kind: "Poll", delayMs: FIVE_SECONDS_MS });
    expect(
      nextObservation({ ...closed, nowMs: WAKE_AT_MS + FIFTEEN_MINUTES_MS }),
    ).toEqual({ kind: "Stopped" });
  });
});
