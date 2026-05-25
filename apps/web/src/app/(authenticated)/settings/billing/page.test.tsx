import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsBillingPaneBody from "./SettingsBillingPaneBody";

const mockBillingState = vi.hoisted(() => ({
  account: {
    billing_enabled: true,
    billing_plan_tier: "free",
    billing_status: "free",
    subscription_current_period_start: null as string | null,
    subscription_current_period_end: null as string | null,
    cancel_at_period_end: false,
    can_manage_billing: false,
    entitlement_plan_tier: "free",
    entitlement_source: "free",
    entitlement_expires_at: null as string | null,
    can_share: false,
    can_use_platform_llm: false,
    can_transcribe: false,
    ai_token_usage: {
      used: 1200,
      reserved: 0,
      limit: 5000 as number | null,
      remaining: 3800 as number | null,
      period_start: "2026-04-01T00:00:00Z",
      period_end: "2026-04-30T23:59:59Z",
    },
    transcription_usage: {
      used: 18,
      reserved: 0,
      limit: 60 as number | null,
      remaining: 42 as number | null,
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
    mockBillingState.account.billing_enabled = true;
    mockBillingState.account.billing_plan_tier = "free";
    mockBillingState.account.billing_status = "free";
    mockBillingState.account.subscription_current_period_start = null;
    mockBillingState.account.subscription_current_period_end = null;
    mockBillingState.account.cancel_at_period_end = false;
    mockBillingState.account.can_manage_billing = false;
    mockBillingState.account.entitlement_plan_tier = "free";
    mockBillingState.account.entitlement_source = "free";
    mockBillingState.account.entitlement_expires_at = null;
    mockBillingState.account.can_share = false;
    mockBillingState.account.can_use_platform_llm = false;
    mockBillingState.account.can_transcribe = false;
    mockBillingState.account.ai_token_usage.limit = 5000;
    mockBillingState.account.ai_token_usage.remaining = 3800;
    mockBillingState.account.transcription_usage.limit = 60;
    mockBillingState.account.transcription_usage.remaining = 42;
    window.history.replaceState(null, "", "/settings/billing");
  });

  it("shows plan, usage, and upgrade actions for a free account", async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValue(new Error("checkout unavailable"));

    render(<SettingsBillingPaneBody />);

    expect(screen.queryByRole("heading", { name: "Billing" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Free")).toHaveLength(3);
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

  it("routes paid subscribers to the billing portal instead of showing checkout upgrades", async () => {
    const user = userEvent.setup();
    mockBillingState.account.billing_plan_tier = "plus";
    mockBillingState.account.billing_status = "active";
    mockBillingState.account.cancel_at_period_end = false;
    mockBillingState.account.can_manage_billing = true;
    mockBillingState.account.entitlement_plan_tier = "plus";
    mockBillingState.account.entitlement_source = "subscription";
    mockBillingState.account.can_share = true;
    mockApiFetch.mockRejectedValue(new Error("portal unavailable"));

    render(<SettingsBillingPaneBody />);

    expect(screen.queryByRole("button", { name: "Upgrade to AI Plus" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade to AI Pro" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage billing" }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/api/billing/portal", {
        method: "POST",
      });
      expect(screen.getByText("Failed to open billing portal")).toBeInTheDocument();
    });
  });

  it("shows disabled billing copy and hides Stripe actions when billing is disabled", () => {
    mockBillingState.account.billing_enabled = false;
    mockBillingState.account.billing_plan_tier = "plus";
    mockBillingState.account.billing_status = "active";
    mockBillingState.account.entitlement_plan_tier = "plus";
    mockBillingState.account.entitlement_source = "subscription";
    mockBillingState.account.can_share = true;

    render(<SettingsBillingPaneBody />);

    expect(
      screen.getByText(
        "Billing is currently disabled. Plan changes and billing management are unavailable right now."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Upgrade to / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage billing" })).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("shows scheduled cancellation instead of renewal copy", () => {
    mockBillingState.account.billing_plan_tier = "plus";
    mockBillingState.account.billing_status = "active";
    mockBillingState.account.entitlement_plan_tier = "plus";
    mockBillingState.account.entitlement_source = "subscription";
    mockBillingState.account.cancel_at_period_end = true;
    mockBillingState.account.subscription_current_period_end = "2026-05-30T23:59:59Z";
    mockBillingState.account.can_share = true;

    render(<SettingsBillingPaneBody />);

    expect(screen.getByText(/^Ends /)).toBeInTheDocument();
    expect(screen.queryByText(/^Renews /)).not.toBeInTheDocument();
  });

  it("shows grant-only unlimited access without Stripe portal actions", () => {
    mockBillingState.account.entitlement_plan_tier = "ai_pro";
    mockBillingState.account.entitlement_source = "internal_grant";
    mockBillingState.account.can_share = true;
    mockBillingState.account.can_use_platform_llm = true;
    mockBillingState.account.can_transcribe = true;
    mockBillingState.account.ai_token_usage.limit = null;
    mockBillingState.account.ai_token_usage.remaining = null;
    mockBillingState.account.transcription_usage.limit = null;
    mockBillingState.account.transcription_usage.remaining = null;

    render(<SettingsBillingPaneBody />);

    expect(screen.getByText("AI Pro")).toBeInTheDocument();
    expect(screen.getByText("Internal grant")).toBeInTheDocument();
    expect(screen.getAllByText(/Unlimited/)).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Manage billing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Upgrade to / })).not.toBeInTheDocument();
  });

});
