import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  isApiError: () => false,
}));

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
      await screen.findByText("Monthly transcription quota was exceeded for this episode."),
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
});
