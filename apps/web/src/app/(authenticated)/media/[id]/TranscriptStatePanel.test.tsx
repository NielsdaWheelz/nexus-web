import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import TranscriptStatePanel from "./TranscriptStatePanel";
import type {
  TranscriptCoverage,
  TranscriptState,
} from "@/lib/media/transcriptView";

const { apiFetchMock, mockBillingState } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  mockBillingState: {
    account: {
      billing_enabled: true,
      billing_plan_tier: "plus",
      billing_status: "active",
      subscription_current_period_start: "2026-04-01T00:00:00Z",
      subscription_current_period_end: "2026-05-01T00:00:00Z",
      cancel_at_period_end: false,
      can_manage_billing: true,
      entitlement_plan_tier: "plus",
      entitlement_source: "subscription",
      entitlement_expires_at: null,
      can_share: true,
      can_use_platform_llm: false,
      can_transcribe: true,
      ai_token_usage: {
        used: 0,
        reserved: 0,
        limit: 0,
        remaining: 0,
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
      },
      transcription_usage: {
        used: 0,
        reserved: 0,
        limit: 120,
        remaining: 30,
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
      },
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  },
}));

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>(
      "@/lib/api/client",
    );
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => mockBillingState,
}));

describe("TranscriptStatePanel", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    mockBillingState.account.can_transcribe = true;
    mockBillingState.account.billing_enabled = true;
    mockBillingState.loading = false;
  });

  it("runs the dry-run forecast once when its result updates to another requestable state", async () => {
    apiFetchMock.mockResolvedValue({
      data: {
        transcript_state: "failed_quota",
        transcript_coverage: "none",
        required_minutes: 42,
        remaining_minutes: 0,
        fits_budget: false,
      },
    });

    function Harness() {
      const [transcriptState, setTranscriptState] =
        useState<TranscriptState>("not_requested");
      const [transcriptCoverage, setTranscriptCoverage] =
        useState<TranscriptCoverage>("none");

      return (
        <TranscriptStatePanel
          mediaId="media-1"
          transcriptState={transcriptState}
          transcriptCoverage={transcriptCoverage}
          onTranscriptStateChange={(update) => {
            setTranscriptState(update.transcriptState);
            setTranscriptCoverage(update.transcriptCoverage);
          }}
        />
      );
    }

    render(<Harness />);

    expect(
      await screen.findByText(
        "Monthly transcription quota was exceeded for this episode.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/media/media-1/transcript/request",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("presents the plan gate before transcript state to an account without transcription", () => {
    mockBillingState.account.can_transcribe = false;

    render(
      <TranscriptStatePanel
        mediaId="media-locked"
        transcriptState="unavailable"
        transcriptCoverage="none"
        onTranscriptStateChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Transcription is included with AI Plus and AI Pro."),
    ).toBeInTheDocument();
    expect(screen.getByText("Current plan: Plus.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Upgrade in Settings, then come back here to request this transcript.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Transcript unavailable for this episode."),
    ).not.toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["E_PODCAST_QUOTA_EXCEEDED", "There isn’t enough transcription quota for this request."],
    ["E_INVALID_KIND", "Transcription isn’t available for this media."],
    ["E_TRANSCRIPT_UNAVAILABLE", "No transcript is available from this source."],
  ])("keeps modeled request failure %s visible", async (code, message) => {
    apiFetchMock
      .mockResolvedValueOnce({
        data: {
          transcript_state: "not_requested",
          transcript_coverage: "none",
          required_minutes: 12,
          remaining_minutes: 30,
          fits_budget: true,
        },
      })
      .mockRejectedValueOnce(
        new ApiError(409, code, "modeled transcript failure", "req-transcript"),
      );

    render(
      <TranscriptStatePanel
        mediaId="media-1"
        transcriptState="not_requested"
        transcriptCoverage="none"
        onTranscriptStateChange={vi.fn()}
      />,
    );
    await screen.findByText("Estimated cost: 12 min");

    fireEvent.click(screen.getByRole("button", { name: "Transcribe this episode" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByText("Nexus request ID: req-transcript")).toBeInTheDocument();
  });
});
