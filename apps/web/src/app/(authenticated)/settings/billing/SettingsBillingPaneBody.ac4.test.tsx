import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { useState } from "react";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { stubFetch, wasFetchPathCalled } from "@/__tests__/helpers/fetch";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import SettingsBillingPaneBody from "./SettingsBillingPaneBody";

// AC-4 hydration-hit guard for the billing pane: when the bootstrap seeds the raw
// /billing/account envelope under the cacheKey the pane reads ("billing-account:0"),
// SettingsBillingPaneBody must paint from that seed without a client fetch — matching the
// server render so hydration does not mismatch (React #418).
//
// The second test is the real regression: the `billing-account:0` seed has more than one
// first-paint consumer (the always-mounted GlobalPlayerFooter reads it too, then the lazy
// billing pane hydrates later). The resource cache is consume-once, so an ambient reader
// that CLAIMED the seed would remove it before the pane hydrates, and the pane would paint
// its loading state against server-rendered content. Ambient readers must therefore read
// without claiming; only the pane (the seed's route owner) claims it.

afterEach(() => {
  vi.restoreAllMocks();
});

const BILLING_SEED = {
  data: {
    billing_enabled: true,
    billing_plan_tier: "free" as const,
    billing_status: "free",
    subscription_current_period_start: null as string | null,
    subscription_current_period_end: null as string | null,
    cancel_at_period_end: false,
    can_manage_billing: false,
    entitlement_plan_tier: "ai_plus" as const,
    entitlement_source: "internal_grant" as const,
    entitlement_expires_at: null as string | null,
    can_share: true,
    can_use_platform_llm: true,
    can_transcribe: true,
    ai_token_usage: {
      used: 0,
      reserved: 0,
      limit: 1_000_000 as number | null,
      remaining: 1_000_000 as number | null,
      period_start: "2026-07-01T00:00:00Z",
      period_end: "2026-07-31T23:59:59Z",
    },
    transcription_usage: {
      used: 0,
      reserved: 0,
      limit: 300 as number | null,
      remaining: 300 as number | null,
      period_start: "2026-07-01T00:00:00Z",
      period_end: "2026-07-31T23:59:59Z",
    },
  },
};

describe("SettingsBillingPaneBody (AC-4 hydration hit)", () => {
  it("paints the seeded billing account and never fetches /api/billing/account", async () => {
    const fetchSpy = stubFetch(async () => {
      throw new Error("unexpected client fetch on a hydration hit");
    });

    renderHydratedPane({
      href: "/settings/billing",
      resources: { "billing-account:0": BILLING_SEED },
      children: withRenderEnvironment(<SettingsBillingPaneBody />),
    });

    // (a) The seeded plan renders from the hydration cache.
    expect(await screen.findByText("AI Plus")).toBeInTheDocument();
    expect(screen.getByText("Internal access grant.")).toBeInTheDocument();

    // (b) No client fetch to the billing account endpoint — the seed was the source.
    expect(wasFetchPathCalled(fetchSpy, "/api/billing/account")).toBe(false);
  });

  it("an ambient consumer that reads the seed first does not starve the pane's first paint", async () => {
    const fetchSpy = stubFetch(async () => {
      throw new Error("unexpected client fetch: the pane was starved of its seed");
    });

    let mountPane: () => void = () => {};

    // Mirrors GlobalPlayerFooter: an always-mounted reader of the same billing seed that
    // commits (and runs its effects) before the lazy billing pane hydrates.
    function AmbientReader() {
      const { account } = useBillingAccount();
      return <div data-testid="ambient">{account ? "ready" : "loading"}</div>;
    }

    function Harness() {
      const [showPane, setShowPane] = useState(false);
      mountPane = () => setShowPane(true);
      return (
        <>
          <AmbientReader />
          {showPane ? <SettingsBillingPaneBody /> : null}
        </>
      );
    }

    renderHydratedPane({
      href: "/settings/billing",
      resources: { "billing-account:0": BILLING_SEED },
      children: withRenderEnvironment(<Harness />),
    });

    // The ambient reader paints from the seed and commits its (non-claiming) effect.
    expect(await screen.findByTestId("ambient")).toHaveTextContent("ready");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Now the lazy pane mounts. The seed must still be present so it paints content
    // rather than falling back to loading (which is what mismatched the server render).
    await act(async () => {
      mountPane();
    });

    expect(await screen.findByText("AI Plus")).toBeInTheDocument();
    expect(wasFetchPathCalled(fetchSpy, "/api/billing/account")).toBe(false);
  });
});
