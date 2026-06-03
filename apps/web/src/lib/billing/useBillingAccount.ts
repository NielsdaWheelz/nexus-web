"use client";

import { useCallback, useState } from "react";
import { useResource } from "@/lib/api/useResource";
import { toFeedback } from "@/components/feedback/Feedback";

export type BillingPlanTier = "free" | "plus" | "ai_plus" | "ai_pro";
type BillingEntitlementSource = "free" | "subscription" | "internal_grant";

interface BillingUsageSnapshot {
  used: number;
  reserved: number;
  limit: number | null;
  remaining: number | null;
  period_start: string;
  period_end: string;
}

interface BillingAccount {
  billing_enabled: boolean;
  billing_plan_tier: BillingPlanTier;
  billing_status: string;
  subscription_current_period_start: string | null;
  subscription_current_period_end: string | null;
  cancel_at_period_end: boolean;
  can_manage_billing: boolean;
  entitlement_plan_tier: BillingPlanTier;
  entitlement_source: BillingEntitlementSource;
  entitlement_expires_at: string | null;
  can_share: boolean;
  can_use_platform_llm: boolean;
  can_transcribe: boolean;
  ai_token_usage: BillingUsageSnapshot;
  transcription_usage: BillingUsageSnapshot;
}

interface BillingAccountResponse {
  data: BillingAccount;
}

export function useBillingAccount() {
  const [reloadVersion, setReloadVersion] = useState(0);
  const accountResource = useResource<BillingAccountResponse>({
    cacheKey: `billing-account:${reloadVersion}`,
    path: () => "/api/billing/account",
  });
  const reload = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  const account =
    accountResource.status === "ready" ? accountResource.data.data : null;
  const loading = accountResource.status === "loading";
  const error =
    accountResource.status === "error"
      ? toFeedback(accountResource.error, {
          fallback: "Failed to load billing account",
        }).title
      : null;

  return { account, loading, error, reload };
}
