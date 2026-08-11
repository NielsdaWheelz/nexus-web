import { describe, expect, it } from "vitest";

import { ActivityRecorder } from "./activityRecorder";
import { parseMediaRef } from "./activityContract";

describe("Consumption activity lifecycle closure", () => {
  it("closes defensible monotonic time into one stable capture fact", () => {
    let monotonicNow = 1_000;
    let wallNow = Date.parse("2026-08-10T18:00:00.000Z");
    const closed: unknown[] = [];
    const diagnostics: unknown[] = [];
    const recorder = new ActivityRecorder({
      now: () => monotonicNow,
      wallNow: () => wallNow,
      closedSpan: (span) => {
        closed.push(span);
      },
      activityDiagnostic: (detail) => diagnostics.push(detail),
    });

    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", {
      mediaRef: parseMediaRef(
        "media:11111111-1111-4111-8111-111111111111",
      ),
      modality: "Reading",
      deviceClass: "Desktop",
      eligible: true,
      measurement: { progress: 0.25, wordPosition: 100 },
    });

    monotonicNow = 6_250;
    wallNow = Date.parse("2026-08-10T18:00:05.250Z");
    recorder.closeForLifecycle("Hidden");

    expect(closed).toEqual([
      {
        captureKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        mediaRef: "media:11111111-1111-4111-8111-111111111111",
        modality: "Reading",
        deviceClass: "Desktop",
        span: {
          occurredAt: "2026-08-10T18:00:00.000Z",
          durationMs: 5_250,
          progressStart: { kind: "Present", value: 0.25 },
          progressEnd: { kind: "Present", value: 0.25 },
          wordStart: { kind: "Present", value: 100 },
          wordEnd: { kind: "Present", value: 100 },
        },
      },
    ]);
    expect(diagnostics).toEqual([
      {
        event: "activity_span_closed",
        platform: "Web",
        modality: "Reading",
        count: 1,
      },
    ]);
  });
});
