import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMediaRef } from "./activityContract";
import { ActivityRecorder } from "./activityRecorder";

const mediaRef = parseMediaRef("media:00000000-0000-4000-8000-000000000701");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function reading(idleUntilMono: number) {
  return {
    mediaRef,
    modality: "Reading" as const,
    deviceClass: "Desktop" as const,
    eligible: true,
    idleUntilMono,
    measurement: { progress: 0.5, wordPosition: 50 },
  };
}

describe("ActivityRecorder browser timing", () => {
  it("clips a delayed reader checkpoint at the genuine-input idle deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-4000-8000-000000000701",
    });
    const now = { value: 0 };
    const uploads: string[] = [];
    const recorder = new ActivityRecorder({
      now: () => now.value,
      wallNow: () => 1_700_000_000_000 + now.value,
      upload: async ({ body }) => {
        uploads.push(body);
        return { kind: "Accepted" };
      },
    });
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", reading(300_000));

    for (let second = 10; second < 300; second += 10) {
      now.value = second * 1_000;
      await vi.advanceTimersByTimeAsync(10_000);
    }
    // The final scheduled checkpoint runs after the browser was suspended. It
    // must retain only the 10 seconds before idleness, never the 50-second gap.
    now.value = 350_000;
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    const capturedMs = uploads.flatMap((body) => {
      const request = JSON.parse(body) as { batch: { spans: Array<{ durationMs: number }> } };
      return request.batch.spans.map((span) => span.durationMs);
    });
    expect(capturedMs.reduce((total, duration) => total + duration, 0)).toBe(300_000);
    recorder.dispose();
  });
});
