"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
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
  const [account, setAccount] = useState<BillingAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiFetch<BillingAccountResponse>("/api/billing/account");
      setAccount(response.data);
    } catch (loadError) {
      setError(toFeedback(loadError, { fallback: "Failed to load billing account" }).title);
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  return { account, loading, error, reload: loadAccount };
}
