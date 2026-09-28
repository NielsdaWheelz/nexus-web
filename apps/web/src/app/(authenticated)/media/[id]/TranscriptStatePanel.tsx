"use client";

import { useCallback, useState } from "react";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import {
  normalizeFragments,
  shouldPollTranscriptProvisioning,
  type Fragment,
  type TranscriptCoverage,
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

export type TranscriptRuntimeUpdate = {
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
  const [transcriptRequestInFlight, setTranscriptRequestInFlight] = useState(false);
  const [requestError, setRequestError] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);

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
    setTranscriptRequestInFlight(true);
    setRequestError(null);
    try {
      const response = await apiFetch<
        ApiJson<"/media/{media_id}/transcript/request", "post">
      >(`/api/media/${mediaId}/transcript/request`, {
        method: "POST",
        body: JSON.stringify({ reason: "episode_open" }),
      });
      const payload = response.data;
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
  }, [mediaId, onTranscriptStateChange, refreshTranscriptState]);

  if (asyncDefect !== null) throw asyncDefect.error;
  const requestFailure = requestError ? (
    <FeedbackNotice content={requestError} announcement="Assertive" />
  ) : null;

  if (
    transcriptState === "not_requested" ||
    transcriptState === "failed_provider" ||
    transcriptState === "failed_quota"
  ) {
    return (
      <div className={styles.notReady}>
        <p>
          {transcriptState === "not_requested"
            ? "Transcript has not been requested yet."
            : "Previous transcription failed. You can retry on demand."}
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={transcriptRequestInFlight}
          onClick={handleRequestTranscript}
        >
          {transcriptRequestInFlight ? "Requesting..." : "Transcribe this episode"}
        </Button>
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
