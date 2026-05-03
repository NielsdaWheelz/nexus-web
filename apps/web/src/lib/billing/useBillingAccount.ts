"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { toFeedback } from "@/components/feedback/Feedback";

export type BillingPlanTier = "free" | "plus" | "ai_plus" | "ai_pro";

export interface BillingUsageSnapshot {
  used: number;
  reserved: number;
  limit: number;
  remaining: number;
  period_start: string;
  period_end: string;
}

export interface BillingAccount {
  billing_enabled: boolean;
  plan_tier: BillingPlanTier;
  subscription_status: string;
  cancel_at_period_end: boolean;
  can_share: boolean;
  can_use_platform_llm: boolean;
  current_period_start: string | null;
  current_period_end: string | null;
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
