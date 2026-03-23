import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  shouldPollTranscriptProvisioning,
  useTranscriptProvisioningPoll,
} from "./transcriptPolling";

describe("shouldPollTranscriptProvisioning", () => {
  it("polls only queued/running transcript media", () => {
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
        transcriptState: "not_requested",
      })
    ).toBe(false);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: "ready",
      })
    ).toBe(false);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: "partial",
      })
    ).toBe(false);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: "failed_provider",
      })
    ).toBe(false);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: "failed_quota",
      })
    ).toBe(false);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: "unavailable",
      })
    ).toBe(false);
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: false,
        transcriptState: "queued",
      })
    ).toBe(false);
  });

  it("does not poll when transcriptState is null even for transcript media", () => {
    expect(
      shouldPollTranscriptProvisioning({
        isTranscriptMedia: true,
        transcriptState: null,
      })
    ).toBe(false);
  });
});

describe("useTranscriptProvisioningPoll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls at the configured interval and stops after disable", async () => {
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
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(onPoll).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(3000);
        await Promise.resolve();
      });
    }
    expect(onPoll).toHaveBeenCalledTimes(3);

    rerender({ enabled: false });

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  it("continues polling after onPoll errors", async () => {
    vi.useFakeTimers();
    const onPoll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient poll error"))
      .mockResolvedValueOnce();

    renderHook(() =>
      useTranscriptProvisioningPoll({
        enabled: true,
        onPoll,
        pollIntervalMs: 1000,
      })
    );

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(onPoll).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });
});
