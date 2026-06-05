import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
      can_transcribe: false,
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
        limit: 0,
        remaining: 0,
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
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    isApiError: () => false,
    isUnauthenticatedApiError: () => false,
  };
});

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => mockBillingState,
}));

import TranscriptStatePanel from "@/app/(authenticated)/media/[id]/TranscriptStatePanel";

describe("TranscriptStatePanel transcript billing", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the settings upgrade prompt when transcription is locked", () => {
    render(
      <TranscriptStatePanel
        mediaId="media-1"
        transcriptState="queued"
        transcriptCoverage="none"
        onTranscriptStateChange={() => {}}
      />
    );

    expect(screen.getByText("Transcription is included with AI Plus and AI Pro.")).toBeInTheDocument();
    expect(screen.getByText("Current plan: Plus.")).toBeInTheDocument();
    expect(
      screen.getByText("Upgrade in Settings, then come back here to request this transcript.")
    ).toBeInTheDocument();
  });

  it("does not dry-run transcription requests while the plan is locked", async () => {
    render(
      <TranscriptStatePanel
        mediaId="media-1"
        transcriptState="not_requested"
        transcriptCoverage="none"
        onTranscriptStateChange={() => {}}
      />
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
