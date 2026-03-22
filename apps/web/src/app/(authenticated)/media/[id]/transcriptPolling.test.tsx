import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  shouldPollTranscriptProvisioning,
  useTranscriptProvisioningPoll,
} from "./transcriptPolling";

describe("shouldPollTranscriptProvisioning", () => {
  it("only polls for queued/running transcript media", () => {
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: "queued",
      })
    ).toBe(true);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: "running",
      })
    ).toBe(true);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: "ready",
      })
    ).toBe(false);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: false,
        transcriptState: "queued",
      })
    ).toBe(false);
  });
});

describe("useTranscriptProvisioningPoll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules polling while enabled and stops after disable", async () => {
    vi.useFakeTimers();
    const onPoll = vi.fn(async () => undefined);

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useTranscriptProvisioningPoll({
          enabled,
          onPoll,
          pollIntervalMs: 1000,
        }),
      {
        initialProps: { enabled: true },
      }
    );

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(onPoll).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(onPoll).toHaveBeenCalledTimes(1);
  });
});
