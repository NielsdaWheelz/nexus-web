import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsBillingPaneBody from "./SettingsBillingPaneBody";

const mockBillingState = vi.hoisted(() => ({
  account: {
    plan_tier: "free",
    subscription_status: "none",
    can_share: false,
    can_use_platform_llm: false,
    current_period_start: null,
    current_period_end: null,
    ai_token_usage: {
      used: 1200,
      reserved: 0,
      limit: 5000,
      remaining: 3800,
      period_start: "2026-04-01T00:00:00Z",
      period_end: "2026-04-30T23:59:59Z",
    },
    transcription_usage: {
      used: 18,
      reserved: 0,
      limit: 60,
      remaining: 42,
      period_start: "2026-04-01T00:00:00Z",
      period_end: "2026-04-30T23:59:59Z",
    },
  },
  loading: false,
  error: null,
  reload: vi.fn(),
}));

const mockApiFetch = vi.fn();

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => mockBillingState,
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  isApiError: () => false,
}));

describe("SettingsBillingPaneBody", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ data: { url: "https://billing.example/checkout" } });
    window.history.replaceState(null, "", "/settings/billing");
  });

  it("shows plan, usage, and upgrade actions for a free account", async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValue(new Error("checkout unavailable"));

    render(<SettingsBillingPaneBody />);

    expect(screen.getByText("Billing")).toBeInTheDocument();
    expect(screen.getAllByText("Free")).toHaveLength(2);
    expect(screen.getByText("AI tokens")).toBeInTheDocument();
    expect(screen.getByText("Transcription")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade to Plus" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade to AI Plus" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade to AI Pro" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage billing" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upgrade to Plus" }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan_tier: "plus" }),
      });
      expect(screen.getByText("Failed to start checkout")).toBeInTheDocument();
    });
  });
});
