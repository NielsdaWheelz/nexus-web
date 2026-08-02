import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

vi.mock("@/lib/auth/UnauthenticatedApiBoundary", () => ({
  handleUnauthenticatedApiError: () => false,
}));

import { useEpisodeTranscriptController } from "./useEpisodeTranscriptController";

function renderController(setError = vi.fn()) {
  return {
    setError,
    view: renderHook(() =>
      useEpisodeTranscriptController({
        podcastId: "podcast-1",
        selection: { state: "all" },
        episodes: [],
        setEpisodes: vi.fn(),
        transcriptionAllowed: true,
        setError,
        reload: vi.fn(),
        onMutationCommitted: vi.fn(),
      }),
    ),
  };
}

describe("useEpisodeTranscriptController finite request feedback", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("keeps a changed batch selection local with its request ID", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiFetchMock
      .mockResolvedValueOnce({
        data: {
          eligibleCount: 2,
          requiredMinutes: 20,
          remainingMinutes: { kind: "Present", value: 60 },
          fitsBudget: true,
          selectionFingerprint: "a".repeat(64),
        },
      })
      .mockRejectedValueOnce(
        new ApiError(409, "E_SELECTION_CHANGED", "selection changed", "req-batch"),
      );
    const { setError, view } = renderController();

    await act(async () => {
      await view.result.current.handleBatchTranscriptRequest();
    });

    expect(setError).toHaveBeenLastCalledWith({
      tone: "Danger",
      title: "Batch transcripts weren’t requested",
      message: "The eligible episode set changed. Review the current list, then retry.",
      requestId: "req-batch",
    });
  });

  it("keeps podcast quota exhaustion local for one episode", async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        data: {
          media_id: "media-1",
          processing_status: "ready_for_reading",
          transcript_state: "not_requested",
          transcript_coverage: "none",
          required_minutes: 20,
          remaining_minutes: 60,
          fits_budget: true,
          request_enqueued: false,
        },
      })
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "E_PODCAST_QUOTA_EXCEEDED",
          "quota exhausted",
          "req-quota",
        ),
      );
    const { setError, view } = renderController();

    await act(async () => {
      await view.result.current.handleRequestTranscript("media-1");
    });

    expect(setError).toHaveBeenLastCalledWith({
      tone: "Danger",
      title: "Transcript wasn’t requested",
      message: "There isn’t enough transcription quota for this request.",
      requestId: "req-quota",
    });
  });
});
