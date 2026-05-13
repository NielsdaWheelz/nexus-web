import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const mockBillingState = vi.hoisted(() => ({
  account: {
    billing_enabled: true,
    plan_tier: "plus",
    subscription_status: "active",
    can_share: true,
    can_use_platform_llm: false,
    current_period_start: "2026-04-01T00:00:00Z",
    current_period_end: "2026-05-01T00:00:00Z",
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
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => mockBillingState,
}));

import TranscriptStatePanel from "@/app/(authenticated)/media/[id]/TranscriptStatePanel";

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

describe("TranscriptStatePanel android shell billing", () => {
  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT);
  });

  it("keeps the settings upgrade prompt in the android shell", () => {
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);

    render(
      <TranscriptStatePanel
        processingStatus="pending"
        transcriptState="not_requested"
        transcriptCoverage="none"
        transcriptRequestInFlight={false}
        transcriptRequestForecast={null}
        onRequestTranscript={() => {}}
      />
    );

    expect(screen.getByText("Transcription is included with AI Plus and AI Pro.")).toBeInTheDocument();
    expect(screen.getByText("Current plan: Plus.")).toBeInTheDocument();
    expect(
      screen.getByText("Upgrade in Settings, then come back here to request this transcript.")
    ).toBeInTheDocument();
  });
});
