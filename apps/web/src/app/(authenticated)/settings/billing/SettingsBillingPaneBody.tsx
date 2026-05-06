"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SectionCard from "@/components/ui/SectionCard";
import Button from "@/components/ui/Button";
import Pill from "@/components/ui/Pill";
import { useBillingAccount, type BillingPlanTier } from "@/lib/billing/useBillingAccount";
import styles from "./page.module.css";

interface CheckoutResponse {
  data: {
    url: string;
  };
}

const PLAN_SEQUENCE: BillingPlanTier[] = ["free", "plus", "ai_plus", "ai_pro"];
const BILLING_DISABLED_MESSAGE =
  "Billing is currently disabled. Plan changes and billing management are unavailable right now.";

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

function statusSummary(account: {
  plan_tier: BillingPlanTier;
  subscription_status: string;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
}): string {
  if (account.plan_tier === "free") {
    return "No active subscription.";
  }
  if (account.subscription_status === "canceled") {
    return account.current_period_end
      ? `Ended ${formatDateRange(null, account.current_period_end)}`
      : "Subscription canceled.";
  }
  if (account.cancel_at_period_end) {
    return account.current_period_end
      ? `Ends ${formatDateRange(null, account.current_period_end)}`
      : "Scheduled to cancel at period end.";
  }
  return account.current_period_end
    ? `Renews ${formatDateRange(null, account.current_period_end)}`
    : "Billing period unavailable.";
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
  const [actionError, setActionError] = useState<FeedbackContent | null>(null);

  const paidPlan = account?.plan_tier ?? "free";
  const billingEnabled = account?.billing_enabled ?? false;
  const currentPlanIndex = activePlanIndex(paidPlan);
  const hasPaidPlan = paidPlan !== "free";
  const showManageBillingAction = billingEnabled && hasPaidPlan;

  let upgradePlans: BillingPlanTier[] = [];
  if (billingEnabled && paidPlan === "free") {
    upgradePlans = PLAN_SEQUENCE.filter(
      (planTier) => activePlanIndex(planTier) > currentPlanIndex
    );
  }

  const showUpgradeActions = upgradePlans.length > 0;

  let actionHint: string | null = null;
  if (showManageBillingAction) {
    actionHint = "Change plan, payment method, or cancellation in Stripe billing.";
  } else if (billingEnabled && paidPlan === "free" && upgradePlans.length === 0) {
    actionHint = "No subscription is active.";
  }

  const launchCheckout = useCallback(
    async (planTier: BillingPlanTier) => {
      if (!billingEnabled) {
        setActionError({ severity: "error", title: BILLING_DISABLED_MESSAGE });
        return;
      }
      setCheckoutBusy(planTier);
      setActionError(null);
      try {
        const response = await apiFetch<CheckoutResponse>("/api/billing/checkout", {
          method: "POST",
          body: JSON.stringify({ plan_tier: planTier }),
        });
        window.location.assign(response.data.url);
      } catch (checkoutError) {
        setActionError(toFeedback(checkoutError, { fallback: "Failed to start checkout" }));
      } finally {
        setCheckoutBusy(null);
      }
    },
    [billingEnabled]
  );

  const launchBillingPortal = useCallback(async () => {
    if (!billingEnabled) {
      setActionError({ severity: "error", title: BILLING_DISABLED_MESSAGE });
      return;
    }
    setPortalBusy(true);
    setActionError(null);
    try {
      const response = await apiFetch<CheckoutResponse>("/api/billing/portal", {
        method: "POST",
      });
      window.location.assign(response.data.url);
    } catch (portalError) {
      setActionError(toFeedback(portalError, { fallback: "Failed to open billing portal" }));
    } finally {
      setPortalBusy(false);
    }
  }, [billingEnabled]);

  return (
    <SectionCard>
      <div className={styles.content}>
        {loading && <FeedbackNotice severity="info">Loading billing account...</FeedbackNotice>}
        {error && <FeedbackNotice severity="error">{error}</FeedbackNotice>}
        {actionError ? <FeedbackNotice feedback={actionError} /> : null}
        {!loading && account && !billingEnabled && (
          <FeedbackNotice severity="info">{BILLING_DISABLED_MESSAGE}</FeedbackNotice>
        )}

        {!loading && account && (
          <>
            <dl className={styles.summaryGrid}>
              <div className={styles.summaryItem}>
                <dt className={styles.summaryLabel}>Plan</dt>
                <dd className={styles.summaryValue}>
                  <Pill tone="info">{planLabel(account.plan_tier)}</Pill>
                  <span className={styles.summaryMeta}>{planDescription(account.plan_tier)}</span>
                </dd>
              </div>

              <div className={styles.summaryItem}>
                <dt className={styles.summaryLabel}>Status</dt>
                <dd className={styles.summaryValue}>
                  <Pill tone={statusVariant(account.subscription_status, account.plan_tier)}>
                    {statusLabel(account.subscription_status, account.plan_tier)}
                  </Pill>
                  <span className={styles.summaryMeta}>{statusSummary(account)}</span>
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

            {(showUpgradeActions || showManageBillingAction || actionHint) && (
              <div className={styles.actionRow}>
                {showUpgradeActions &&
                  upgradePlans.map((planTier) => (
                    <Button
                      key={planTier}
                      variant="primary"
                      disabled={checkoutBusy !== null || portalBusy}
                      onClick={() => {
                        void launchCheckout(planTier);
                      }}
                    >
                      {checkoutBusy === planTier
                        ? `Opening ${planLabel(planTier)}...`
                        : `Upgrade to ${planLabel(planTier)}`}
                    </Button>
                  ))}

                {showManageBillingAction && (
                  <Button
                    variant="secondary"
                    disabled={checkoutBusy !== null || portalBusy}
                    onClick={() => {
                      void launchBillingPortal();
                    }}
                  >
                    {portalBusy ? "Opening billing..." : "Manage billing"}
                  </Button>
                )}

                {actionHint && <span className={styles.actionHint}>{actionHint}</span>}
              </div>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
