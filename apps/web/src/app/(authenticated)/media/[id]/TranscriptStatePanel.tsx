"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { useBillingAccount, type BillingPlanTier } from "@/lib/billing/useBillingAccount";
import {
  canRequestTranscript,
  shouldPollTranscriptProvisioning,
  type Fragment,
  type TranscriptCoverage,
  type TranscriptRequestForecast,
  type TranscriptState,
} from "./transcriptView";
import styles from "./page.module.css";

const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;

function planLabel(planTier: BillingPlanTier): string {
  if (planTier === "plus") return "Plus";
  if (planTier === "ai_plus") return "AI Plus";
  if (planTier === "ai_pro") return "AI Pro";
  return "Free";
}

type TranscriptCapabilities = {
  can_read: boolean;
  can_highlight: boolean;
  can_quote: boolean;
  can_search: boolean;
  can_play: boolean;
  can_download_file: boolean;
};

type TranscriptRuntimeUpdate = {
  transcriptState: TranscriptState;
  transcriptCoverage: TranscriptCoverage;
  capabilities: TranscriptCapabilities | null;
  lastErrorCode: string | null;
  fragments: Fragment[] | null;
};

interface TranscriptStatePanelProps {
  mediaId: string;
  transcriptState: TranscriptState;
  transcriptCoverage: TranscriptCoverage;
  onTranscriptStateChange: (update: TranscriptRuntimeUpdate) => void;
}

export default function TranscriptStatePanel({
  mediaId,
  transcriptState,
  transcriptCoverage,
  onTranscriptStateChange,
}: TranscriptStatePanelProps) {
  const { account: billingAccount } = useBillingAccount();
  const [transcriptRequestInFlight, setTranscriptRequestInFlight] = useState(false);
  const [transcriptRequestForecast, setTranscriptRequestForecast] =
    useState<TranscriptRequestForecast | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const requestDisabled =
    transcriptRequestInFlight ||
    (transcriptRequestForecast ? !transcriptRequestForecast.fitsBudget : false);
  const billingDisabled = billingAccount?.billing_enabled === false;
  const transcriptionLocked =
    billingAccount != null &&
    (billingAccount.plan_tier === "free" || billingAccount.plan_tier === "plus");

  const refreshTranscriptState = useCallback(async () => {
    const mediaResponse = await apiFetch<{
      data: {
        transcript_state: TranscriptState;
        transcript_coverage: TranscriptCoverage;
        last_error_code: string | null;
        capabilities?: TranscriptCapabilities | null;
      };
    }>(`/api/media/${mediaId}`);
    const nextCapabilities = mediaResponse.data.capabilities ?? null;

    if (!nextCapabilities?.can_read) {
      onTranscriptStateChange({
        transcriptState: mediaResponse.data.transcript_state,
        transcriptCoverage: mediaResponse.data.transcript_coverage,
        capabilities: nextCapabilities,
        lastErrorCode: mediaResponse.data.last_error_code,
        fragments: null,
      });
      return;
    }

    const fragmentsResponse = await apiFetch<{ data: Fragment[] }>(
      `/api/media/${mediaId}/fragments`
    );
    onTranscriptStateChange({
      transcriptState: mediaResponse.data.transcript_state,
      transcriptCoverage: mediaResponse.data.transcript_coverage,
      capabilities: nextCapabilities,
      lastErrorCode: mediaResponse.data.last_error_code,
      fragments: fragmentsResponse.data,
    });
  }, [mediaId, onTranscriptStateChange]);

  useEffect(() => {
    if (!canRequestTranscript(transcriptState)) {
      setTranscriptRequestForecast(null);
      setRequestError(null);
      return;
    }

    let cancelled = false;
    const loadForecast = async () => {
      try {
        const forecastResponse = await apiFetch<{
          data: {
            transcript_state: TranscriptState;
            transcript_coverage: TranscriptCoverage;
            required_minutes: number;
            remaining_minutes: number | null;
            fits_budget: boolean;
          };
        }>(`/api/media/${mediaId}/transcript/request`, {
          method: "POST",
          body: JSON.stringify({
            reason: "episode_open",
            dry_run: true,
          }),
        });
        if (cancelled) {
          return;
        }

        const payload = forecastResponse.data;
        setTranscriptRequestForecast({
          requiredMinutes: payload.required_minutes,
          remainingMinutes: payload.remaining_minutes,
          fitsBudget: payload.fits_budget,
        });
        setRequestError(null);
        onTranscriptStateChange({
          transcriptState: payload.transcript_state,
          transcriptCoverage: payload.transcript_coverage,
          capabilities: null,
          lastErrorCode: null,
          fragments: null,
        });
      } catch {
        if (!cancelled) {
          setTranscriptRequestForecast(null);
        }
      }
    };

    void loadForecast();
    return () => {
      cancelled = true;
    };
  }, [mediaId, onTranscriptStateChange, transcriptState]);

  useEffect(() => {
    if (!shouldPollTranscriptProvisioning(transcriptState)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void refreshTranscriptState().catch(() => {
        // Keep the request UI responsive even if one poll cycle fails.
      });
    }, TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [refreshTranscriptState, transcriptState]);

  const handleRequestTranscript = useCallback(async () => {
    setTranscriptRequestInFlight(true);
    setRequestError(null);
    try {
      const response = await apiFetch<{
        data: {
          transcript_state: TranscriptState;
          transcript_coverage: TranscriptCoverage;
          required_minutes: number;
          remaining_minutes: number | null;
          fits_budget: boolean;
          request_enqueued: boolean;
        };
      }>(`/api/media/${mediaId}/transcript/request`, {
        method: "POST",
        body: JSON.stringify({
          reason: "episode_open",
          dry_run: false,
        }),
      });
      const payload = response.data;
      setTranscriptRequestForecast({
        requiredMinutes: payload.required_minutes,
        remainingMinutes: payload.remaining_minutes,
        fitsBudget: payload.fits_budget,
      });
      onTranscriptStateChange({
        transcriptState: payload.transcript_state,
        transcriptCoverage: payload.transcript_coverage,
        capabilities: null,
        lastErrorCode: null,
        fragments: null,
      });

      if (
        payload.transcript_state === "ready" ||
        payload.transcript_state === "partial"
      ) {
        await refreshTranscriptState();
      }
    } catch (error) {
      if (isApiError(error)) {
        setRequestError(error.message);
      } else {
        setRequestError("Failed to request transcript.");
      }
    } finally {
      setTranscriptRequestInFlight(false);
    }
  }, [mediaId, onTranscriptStateChange, refreshTranscriptState]);

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
          onClick={handleRequestTranscript}
        >
          {transcriptRequestInFlight ? "Requesting..." : "Transcribe this episode"}
        </button>
        {transcriptRequestForecast && !transcriptRequestForecast.fitsBudget ? (
          <p>Not enough monthly transcription quota for this request.</p>
        ) : null}
        {requestError ? <p>{requestError}</p> : null}
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
        {requestError ? <p>{requestError}</p> : null}
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
      {requestError ? <p>{requestError}</p> : null}
    </div>
  );
}
