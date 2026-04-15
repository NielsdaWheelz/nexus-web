"use client";

import { useCallback, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import { useBillingAccount, type BillingPlanTier } from "@/lib/billing/useBillingAccount";
import styles from "./page.module.css";

interface CheckoutResponse {
  data: {
    url: string;
  };
}

const PLAN_SEQUENCE: BillingPlanTier[] = ["free", "plus", "ai_plus", "ai_pro"];

function planLabel(planTier: BillingPlanTier): string {
  if (planTier === "plus") return "Plus";
  if (planTier === "ai_plus") return "AI Plus";
  if (planTier === "ai_pro") return "AI Pro";
  return "Free";
}

function planDescription(planTier: BillingPlanTier): string {
  if (planTier === "plus") return "Sharing and collaboration.";
  if (planTier === "ai_plus") return "Sharing, platform AI, and transcription.";
  if (planTier === "ai_pro") return "Higher AI and transcription limits.";
  return "Private solo use with BYOK only.";
}

function statusLabel(status: string, planTier: BillingPlanTier): string {
  if (planTier === "free") return "Free";
  if (status === "trialing") return "Trialing";
  if (status === "active") return "Active";
  if (status === "past_due") return "Past due";
  if (status === "canceled") return "Canceled";
  if (status === "incomplete") return "Incomplete";
  if (status === "incomplete_expired") return "Expired";
  if (status === "unpaid") return "Unpaid";
  return status;
}

function statusVariant(status: string, planTier: BillingPlanTier) {
  if (planTier === "free" || status === "canceled" || status === "incomplete_expired") {
    return "neutral" as const;
  }
  if (status === "active" || status === "trialing") {
    return "success" as const;
  }
  if (status === "past_due" || status === "incomplete" || status === "unpaid") {
    return "warning" as const;
  }
  return "info" as const;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start && !end) {
    return "Unavailable";
  }
  const parts: string[] = [];
  if (start) {
    const startDate = new Date(start);
    parts.push(Number.isNaN(startDate.getTime()) ? start : startDate.toLocaleDateString());
  }
  if (end) {
    const endDate = new Date(end);
    parts.push(Number.isNaN(endDate.getTime()) ? end : endDate.toLocaleDateString());
  }
  return parts.join(" - ");
}

function formatUsage(value: number | null, unit: string): string {
  if (value === null) {
    return "Unlimited";
  }
  return `${new Intl.NumberFormat().format(value)} ${unit}`;
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

function activePlanIndex(planTier: BillingPlanTier): number {
  return PLAN_SEQUENCE.indexOf(planTier);
}

export default function SettingsBillingPaneBody() {
  const { account, loading, error } = useBillingAccount();
  const [checkoutBusy, setCheckoutBusy] = useState<BillingPlanTier | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const paidPlan = account?.plan_tier ?? "free";
  const currentPlanIndex = activePlanIndex(paidPlan);
  const canManageBilling = paidPlan !== "free";

  const upgradePlans = useMemo(
    () => PLAN_SEQUENCE.filter((planTier) => activePlanIndex(planTier) > currentPlanIndex),
    [currentPlanIndex]
  );

  const launchCheckout = useCallback(
    async (planTier: BillingPlanTier) => {
      setCheckoutBusy(planTier);
      setActionError(null);
      try {
        const response = await apiFetch<CheckoutResponse>("/api/billing/checkout", {
          method: "POST",
          body: JSON.stringify({ plan_tier: planTier }),
        });
        window.location.assign(response.data.url);
      } catch (checkoutError) {
        if (isApiError(checkoutError)) {
          setActionError(checkoutError.message);
        } else {
          setActionError("Failed to start checkout");
        }
      } finally {
        setCheckoutBusy(null);
      }
    },
    []
  );

  const launchBillingPortal = useCallback(async () => {
    setPortalBusy(true);
    setActionError(null);
    try {
      const response = await apiFetch<CheckoutResponse>("/api/billing/portal", {
        method: "POST",
      });
      window.location.assign(response.data.url);
    } catch (portalError) {
      if (isApiError(portalError)) {
        setActionError(portalError.message);
      } else {
        setActionError("Failed to open billing portal");
      }
    } finally {
      setPortalBusy(false);
    }
  }, []);

  return (
    <SectionCard
      title="Billing"
      description="Plan, subscription state, and included AI usage."
    >
      <div className={styles.content}>
        {loading && <StateMessage variant="loading">Loading billing account...</StateMessage>}
        {error && <StateMessage variant="error">{error}</StateMessage>}
        {actionError && <StateMessage variant="error">{actionError}</StateMessage>}

        {!loading && account && (
          <>
            <dl className={styles.summaryGrid}>
              <div className={styles.summaryItem}>
                <dt className={styles.summaryLabel}>Plan</dt>
                <dd className={styles.summaryValue}>
                  <StatusPill variant="info">{planLabel(account.plan_tier)}</StatusPill>
                  <span className={styles.summaryMeta}>{planDescription(account.plan_tier)}</span>
                </dd>
              </div>

              <div className={styles.summaryItem}>
                <dt className={styles.summaryLabel}>Status</dt>
                <dd className={styles.summaryValue}>
                  <StatusPill variant={statusVariant(account.subscription_status, account.plan_tier)}>
                    {statusLabel(account.subscription_status, account.plan_tier)}
                  </StatusPill>
                  <span className={styles.summaryMeta}>
                    {account.plan_tier === "free"
                      ? "No active subscription."
                      : `Renews ${formatDateRange(null, account.current_period_end)}`}
                  </span>
                </dd>
              </div>

              <div className={styles.summaryItem}>
                <dt className={styles.summaryLabel}>Billing period</dt>
                <dd className={styles.summaryValue}>
                  <span className={styles.summaryText}>
                    {formatDateRange(account.current_period_start, account.current_period_end)}
                  </span>
                </dd>
              </div>
            </dl>

            <div className={styles.usageGrid}>
              <section className={styles.usageCard}>
                <h3 className={styles.usageTitle}>AI tokens</h3>
                <p className={styles.usageValue}>
                  {formatUsage(account.ai_token_usage.used, "tokens")}
                </p>
                <p className={styles.usageMeta}>
                  Limit: {formatUsage(account.ai_token_usage.limit, "tokens")}
                </p>
                <p className={styles.usageMeta}>
                  Remaining: {formatUsage(account.ai_token_usage.remaining, "tokens")}
                </p>
              </section>

              <section className={styles.usageCard}>
                <h3 className={styles.usageTitle}>Transcription</h3>
                <p className={styles.usageValue}>
                  {formatUsage(account.transcription_usage.used, "minutes")}
                </p>
                <p className={styles.usageMeta}>
                  Limit: {formatUsage(account.transcription_usage.limit, "minutes")}
                </p>
                <p className={styles.usageMeta}>
                  Remaining: {formatUsage(account.transcription_usage.remaining, "minutes")}
                </p>
              </section>
            </div>

            <div className={styles.entitlementRow}>
              <span>Sharing: {yesNo(account.can_share)}</span>
              <span>Platform AI: {yesNo(account.can_use_platform_llm)}</span>
              <span>Transcription: {yesNo(account.transcription_usage.limit > 0)}</span>
            </div>

            <div className={styles.actionRow}>
              {upgradePlans.map((planTier) => (
                <button
                  key={planTier}
                  type="button"
                  className={styles.upgradeButton}
                  disabled={checkoutBusy !== null || portalBusy}
                  onClick={() => {
                    void launchCheckout(planTier);
                  }}
                >
                  {checkoutBusy === planTier ? `Opening ${planLabel(planTier)}...` : `Upgrade to ${planLabel(planTier)}`}
                </button>
              ))}

              {canManageBilling && (
                <button
                  type="button"
                  className={styles.manageButton}
                  disabled={checkoutBusy !== null || portalBusy}
                  onClick={() => {
                    void launchBillingPortal();
                  }}
                >
                  {portalBusy ? "Opening billing..." : "Manage billing"}
                </button>
              )}

              {paidPlan === "free" && upgradePlans.length === 0 && (
                <span className={styles.actionHint}>No subscription is active.</span>
              )}
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}
