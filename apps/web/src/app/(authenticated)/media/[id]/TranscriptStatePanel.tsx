"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { planLabel } from "@/lib/billing/planLabel";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { isAbortError } from "@/lib/errors";
import {
  canRequestTranscript,
  normalizeFragments,
  shouldPollTranscriptProvisioning,
  type Fragment,
  type TranscriptCoverage,
  type TranscriptRequestForecast,
  type TranscriptState,
} from "@/lib/media/transcriptView";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import styles from "./page.module.css";

const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;

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

function transcriptRequestErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  const title = "Transcript wasn’t requested";
  switch (error.code) {
    case "E_NETWORK":
      return { tone: "Danger", title, message: "Check your connection and retry.", requestId };
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "The transcription service took too long to respond. Retry the request.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return { tone: "Danger", title, message: "Wait a moment, then retry.", requestId };
    case "E_MEDIA_NOT_FOUND":
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This episode is no longer available. Return to your podcast.",
        requestId,
      };
    case "E_MEDIA_NOT_READY":
      return {
        tone: "Danger",
        title,
        message: "This episode is still preparing. Wait for it to settle, then retry.",
        requestId,
      };
    case "E_PODCAST_QUOTA_EXCEEDED":
      return {
        tone: "Danger",
        title,
        message: "There isn’t enough transcription quota for this request.",
        requestId,
      };
    case "E_BILLING_REQUIRED":
    case "E_BILLING_DISABLED":
      return {
        tone: "Danger",
        title,
        message: "Transcription isn’t available on this account. Review billing settings.",
        requestId,
      };
    case "E_INVALID_KIND":
      return {
        tone: "Danger",
        title,
        message: "Transcription isn’t available for this media.",
        requestId,
      };
    case "E_TRANSCRIPT_UNAVAILABLE":
      return {
        tone: "Danger",
        title,
        message: "No transcript is available from this source.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title,
        message: "The episode changed. Refresh it, then retry.",
        requestId,
      };
    default:
      throw error;
  }
}

export default function TranscriptStatePanel({
  mediaId,
  transcriptState,
  transcriptCoverage,
  onTranscriptStateChange,
}: TranscriptStatePanelProps) {
  const { account: billingAccount, loading: billingLoading } = useBillingAccount();
  const [transcriptRequestInFlight, setTranscriptRequestInFlight] = useState(false);
  const [transcriptRequestForecast, setTranscriptRequestForecast] =
    useState<TranscriptRequestForecast | null>(null);
  const [requestError, setRequestError] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const onTranscriptStateChangeRef = useRef(onTranscriptStateChange);
  const billingDisabled = billingAccount?.billing_enabled === false;
  const transcriptionLocked = billingAccount != null && !billingAccount.can_transcribe;
  const requestDisabled =
    billingLoading ||
    billingDisabled ||
    transcriptionLocked ||
    transcriptRequestInFlight ||
    (transcriptRequestForecast ? !transcriptRequestForecast.fitsBudget : false);

  useEffect(() => {
    onTranscriptStateChangeRef.current = onTranscriptStateChange;
  }, [onTranscriptStateChange]);

  const transcriptForecastKey = useMemo(() => {
    if (
      billingLoading ||
      billingDisabled ||
      transcriptionLocked ||
      !canRequestTranscript(transcriptState)
    ) {
      return null;
    }

    return mediaId;
  }, [
    billingDisabled,
    billingLoading,
    mediaId,
    transcriptState,
    transcriptionLocked,
  ]);

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
      fragments: normalizeFragments(fragmentsResponse.data),
    });
  }, [mediaId, onTranscriptStateChange]);

  useEffect(() => {
    if (transcriptForecastKey === null) {
      setTranscriptRequestForecast(null);
      setRequestError(null);
      return;
    }

    const controller = new AbortController();
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
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }

        const payload = forecastResponse.data;
        setTranscriptRequestForecast({
          requiredMinutes: payload.required_minutes,
          remainingMinutes: payload.remaining_minutes,
          fitsBudget: payload.fits_budget,
        });
        setRequestError(null);
        onTranscriptStateChangeRef.current({
          transcriptState: payload.transcript_state,
          transcriptCoverage: payload.transcript_coverage,
          capabilities: null,
          lastErrorCode: null,
          fragments: null,
        });
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) {
          if (handleUnauthenticatedApiError(error)) return;
          setTranscriptRequestForecast(null);
          try {
            transcriptRequestErrorMessage(error);
          } catch (defect) {
            setAsyncDefect({ error: defect });
          }
        }
      }
    };

    void loadForecast();
    return () => {
      controller.abort();
    };
  }, [mediaId, transcriptForecastKey]);

  // justify-polling: transcript provisioning is backend async work without a
  // stream today; transcript state terminates the schedule.
  useIntervalPoll({
    enabled: shouldPollTranscriptProvisioning(transcriptState),
    onPoll: async () => {
      await refreshTranscriptState().catch((error) => {
        if (handleUnauthenticatedApiError(error)) return;
        try {
          transcriptRequestErrorMessage(error);
        } catch (defect) {
          setAsyncDefect({ error: defect });
        }
      });
    },
    pollIntervalMs: TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS,
  });

  const handleRequestTranscript = useCallback(async () => {
    if (billingDisabled || billingLoading || transcriptionLocked) {
      return;
    }

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
      if (handleUnauthenticatedApiError(error)) return;
      try {
        setRequestError(transcriptRequestErrorMessage(error));
      } catch (defect) {
        setAsyncDefect({ error: defect });
      }
    } finally {
      setTranscriptRequestInFlight(false);
    }
  }, [
    billingDisabled,
    billingLoading,
    mediaId,
    onTranscriptStateChange,
    refreshTranscriptState,
    transcriptionLocked,
  ]);

  if (asyncDefect !== null) throw asyncDefect.error;
  const requestFailure = requestError ? (
    <FeedbackNotice content={requestError} announcement="Assertive" />
  ) : null;

  if (transcriptionLocked) {
    return (
      <div className={styles.notReady}>
        <p>Transcription is included with AI Plus and AI Pro.</p>
        <p>
          Current plan:{" "}
          {billingAccount ? planLabel(billingAccount.entitlement_plan_tier) : "Free"}.
        </p>
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
        <Button
          variant="secondary"
          size="sm"
          disabled={requestDisabled}
          onClick={handleRequestTranscript}
        >
          {transcriptRequestInFlight ? "Requesting..." : "Transcribe this episode"}
        </Button>
        {transcriptRequestForecast && !transcriptRequestForecast.fitsBudget ? (
          <p>Not enough monthly transcription quota for this request.</p>
        ) : null}
        {requestFailure}
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
        {requestFailure}
      </div>
    );
  }

  if (transcriptState === "unavailable") {
    return (
      <div className={styles.notReady}>
        <p>Transcript unavailable for this episode.</p>
      </div>
    );
  }

  return (
    <div className={styles.notReady}>
      <p>This media is still being processed.</p>
      {transcriptCoverage ? <p>Coverage: {transcriptCoverage}</p> : null}
      {requestFailure}
    </div>
  );
}
