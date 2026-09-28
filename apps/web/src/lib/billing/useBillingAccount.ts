"use client";

import { useCallback, useState } from "react";
import { billingAccountResource } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import type { ApiError } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type BillingPlanTier = Schema<"BillingAccountOut">["billing_plan_tier"];

function billingAccountErrorMessage(error: ApiError): string {
  switch (error.code) {
    case "E_FORBIDDEN":
      return "You don’t have access to billing details.";
    case "E_NOT_FOUND":
      return "Billing details couldn’t be loaded.";
    default:
      throw error;
  }
}

// The billing account seed (cacheKey `billing-account:0`) has multiple simultaneous
// first-paint consumers: the settings-billing pane it is seeded for, the always-mounted
// player surfaces, and (in multi-pane workspaces) media/podcast panes. The resource
// cache is consume-once, so if an ambient reader claimed the seed it would starve the
// pane, whose lazy chunk hydrates later — the pane would then render its loading state
// against the server-rendered content and hydration would mismatch (React #418). So only
// the seed's route owner (the settings-billing pane) claims it; every other reader passes
// the default `claimSeed: false` and paints from the seed without removing it.
export function useBillingAccount(options?: { claimSeed?: boolean }) {
  const [reloadVersion, setReloadVersion] = useState(0);
  const accountResource = useResource<
    ApiJson<"/billing/account", "get">,
    { refreshVersion: number }
  >({
    descriptor: billingAccountResource,
    params: { refreshVersion: reloadVersion },
    claimSeed: options?.claimSeed ?? false,
  });
  const reload = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  const account =
    accountResource.status === "ready" ? accountResource.data.data : null;
  const loading = accountResource.status === "loading";
  const error =
    accountResource.status === "error"
      ? billingAccountErrorMessage(accountResource.error)
      : null;

  return { account, loading, error, reload };
}
