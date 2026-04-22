"use client";

import { useBillingAccount, type BillingPlanTier } from "@/lib/billing/useBillingAccount";
import { type TranscriptRequestForecast } from "./transcriptView";
import styles from "./page.module.css";

function planLabel(planTier: BillingPlanTier): string {
  if (planTier === "plus") return "Plus";
  if (planTier === "ai_plus") return "AI Plus";
  if (planTier === "ai_pro") return "AI Pro";
  return "Free";
}

interface TranscriptStatePanelProps {
  transcriptState:
    | "not_requested"
    | "queued"
    | "running"
    | "failed_provider"
    | "failed_quota"
    | "unavailable"
    | "ready"
    | "partial"
    | null;
  transcriptCoverage: "none" | "partial" | "full" | null;
  transcriptRequestInFlight: boolean;
  transcriptRequestForecast: TranscriptRequestForecast | null;
  onRequestTranscript: () => void;
}

export default function TranscriptStatePanel({
  transcriptState,
  transcriptCoverage,
  transcriptRequestInFlight,
  transcriptRequestForecast,
  onRequestTranscript,
}: TranscriptStatePanelProps) {
  const { account: billingAccount } = useBillingAccount();
  const requestDisabled =
    transcriptRequestInFlight ||
    (transcriptRequestForecast ? !transcriptRequestForecast.fitsBudget : false);
  const billingDisabled = billingAccount?.billing_enabled === false;
  const transcriptionLocked =
    billingAccount != null &&
    (billingAccount.plan_tier === "free" || billingAccount.plan_tier === "plus");

  if (transcriptionLocked) {
    return (
      <div className={styles.notReady}>
        <p>Transcription is included with AI Plus and AI Pro.</p>
        <p>Current plan: {billingAccount ? planLabel(billingAccount.plan_tier) : "Free"}.</p>
        <p>
          {billingDisabled
            ? "Billing is temporarily unavailable, so plan upgrades are unavailable right now."
            : "Upgrade in Settings, then come back here to request this transcript."}
        </p>
      </div>
    );
  }

  if (
    transcriptState === "not_requested" ||
    transcriptState === "failed_provider" ||
    transcriptState === "failed_quota"
  ) {
    return (
      <div className={styles.notReady}>
        <p>
          {transcriptState === "failed_provider"
            ? "Previous transcription failed. You can retry on demand."
            : transcriptState === "failed_quota"
              ? "Monthly transcription quota was exceeded for this episode."
              : "Transcript has not been requested yet."}
        </p>
        {transcriptRequestForecast ? (
          <>
            <p>Estimated cost: {transcriptRequestForecast.requiredMinutes} min</p>
            <p>
              Remaining this month:{" "}
              {transcriptRequestForecast.remainingMinutes == null
                ? "unlimited"
                : `${transcriptRequestForecast.remainingMinutes} min`}
            </p>
          </>
        ) : null}
        <button
          type="button"
          className={styles.globalPlayerButton}
          disabled={requestDisabled}
          onClick={() => onRequestTranscript()}
        >
          {transcriptRequestInFlight ? "Requesting..." : "Transcribe this episode"}
        </button>
        {transcriptRequestForecast && !transcriptRequestForecast.fitsBudget ? (
          <p>Not enough monthly transcription quota for this request.</p>
        ) : null}
      </div>
    );
  }

  if (transcriptState === "queued" || transcriptState === "running") {
    return (
      <div className={styles.notReady}>
        <p>
          {transcriptState === "queued"
            ? "Transcript request queued."
            : "Transcript transcription is currently running."}
        </p>
      </div>
    );
  }

  if (transcriptState === "unavailable") {
    return (
      <div className={styles.notReady}>
        <p>Transcript unavailable for this episode.</p>
        <p>Error: E_TRANSCRIPT_UNAVAILABLE</p>
      </div>
    );
  }

  return (
    <div className={styles.notReady}>
      <p>This media is still being processed.</p>
      {transcriptCoverage ? <p>Coverage: {transcriptCoverage}</p> : null}
    </div>
  );
}
