"use client";

import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { useStringIdSet } from "@/lib/useStringIdSet";
import {
  TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS,
  shouldPollTranscriptProvisioningForEpisode,
  type PodcastEpisodeMedia,
  type TranscriptRequestReason,
} from "./episodeTranscript";

interface UseEpisodeTranscriptControllerArgs {
  podcastId: string;
  selection: {
    state: "all" | "unplayed" | "in_progress" | "played";
  };
  episodes: PodcastEpisodeMedia[];
  setEpisodes: Dispatch<SetStateAction<PodcastEpisodeMedia[]>>;
  setError: (feedback: FeedbackContent | null) => void;
  reload: () => void;
  onMutationCommitted: () => void;
}

type TranscriptRequestOperation = "Batch" | "Episode";

function transcriptRequestErrorMessage(
  error: unknown,
  operation: TranscriptRequestOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  const title =
    operation === "Batch"
      ? "Batch transcripts weren’t requested"
      : "Transcript wasn’t requested";
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
        message: "This episode is no longer available. Refresh the pane.",
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
      if (operation !== "Episode") throw error;
      return {
        tone: "Danger",
        title,
        message: "Transcription isn’t available for this media.",
        requestId,
      };
    case "E_TRANSCRIPT_UNAVAILABLE":
      if (operation !== "Episode") throw error;
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
        message: "The eligible episode set changed. Refresh the pane, then retry.",
        requestId,
      };
    case "E_SELECTION_CHANGED":
      if (operation !== "Batch") throw error;
      return {
        tone: "Danger",
        title,
        message: "The eligible episode set changed. Review the current list, then retry.",
        requestId,
      };
    default:
      throw error;
  }
}

/**
 * Owns the episode-transcript subsystem for the podcast-detail pane: per-episode
 * reason/request state, the provisioning poll, and the batch + single
 * transcript-request handlers. It reads/writes the pane's `episodes` list and
 * reports failures through `setError`; a successful request triggers `reload`.
 */
export function useEpisodeTranscriptController({
  podcastId,
  selection,
  episodes,
  setEpisodes,
  setError,
  reload,
  onMutationCommitted,
}: UseEpisodeTranscriptControllerArgs) {
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const [batchTranscriptBusy, setBatchTranscriptBusy] = useState(false);
  const [batchTranscriptSummary, setBatchTranscriptSummary] = useState<
    string | null
  >(null);
  const expandedTranscriptMediaIds = useStringIdSet();
  const requestingTranscriptMediaIds = useStringIdSet();
  const [transcriptReasonByMediaId, setTranscriptReasonByMediaId] = useState<
    Record<string, TranscriptRequestReason>
  >({});
  const reportRequestError = useCallback(
    (error: unknown, operation: TranscriptRequestOperation) => {
      try {
        setError(transcriptRequestErrorMessage(error, operation));
      } catch (defect) {
        setAsyncDefect({ error: defect });
      }
    },
    [setError],
  );

  const handleBatchTranscriptRequest = useCallback(async () => {
    setBatchTranscriptBusy(true);
    setError(null);
    try {
      const target = {
        kind: "PodcastEpisodeQuery" as const,
        podcastId,
        selection,
        reason: "search" as const,
      };
      const forecast = await apiFetch<
        ApiJson<"/media/transcript/forecasts", "post">
      >("/api/media/transcript/forecasts", {
        method: "POST",
        body: JSON.stringify(target),
      });
      if (
        !window.confirm(
          [
            `Eligible episodes: ${forecast.data.eligibleCount}`,
            "",
            "Submit batch transcript request?",
          ].join("\n"),
        )
      ) {
        return;
      }
      const response = await apiFetch<
        ApiJson<"/media/transcript/request/batch", "post">
      >("/api/media/transcript/request/batch", {
        method: "POST",
        body: JSON.stringify({
          target,
          selectionFingerprint: forecast.data.selectionFingerprint,
        }),
      });
      setBatchTranscriptSummary(
        `${response.data.queuedCount} of ${response.data.matchedCount} eligible episodes queued.`,
      );
      reload();
    } catch (requestError) {
      if (handleUnauthenticatedApiError(requestError)) return;
      reportRequestError(requestError, "Batch");
    } finally {
      setBatchTranscriptBusy(false);
    }
  }, [podcastId, reportRequestError, reload, selection, setError]);

  const provisioningEpisodeIds = useMemo(
    () =>
      episodes
        .filter((episode) => shouldPollTranscriptProvisioningForEpisode(episode))
        .map((episode) => episode.id),
    [episodes],
  );

  // justify-polling: transcript provisioning is backend async work without a
  // push stream here; the eligible episode set terminates the schedule.
  useIntervalPoll({
    enabled: provisioningEpisodeIds.length > 0,
    onPoll: async () => {
      reload();
    },
    pollIntervalMs: TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS,
  });

  const handleRequestTranscript = useCallback(
    async (mediaId: string) => {
      const reason = transcriptReasonByMediaId[mediaId] ?? "search";
      requestingTranscriptMediaIds.add(mediaId);
      setError(null);
      try {
        const response = await apiFetch<
          ApiJson<"/media/{media_id}/transcript/request", "post">
        >(`/api/media/${mediaId}/transcript/request`, {
          method: "POST",
          body: JSON.stringify({ reason }),
        });
        const payload = response.data;
        setEpisodes((prev) =>
          prev.map((episode) =>
            episode.id === mediaId
              ? {
                  ...episode,
                  transcript_state: payload.transcript_state,
                  transcript_coverage: payload.transcript_coverage,
                }
              : episode,
          ),
        );
        onMutationCommitted();
        reload();
      } catch (requestError) {
        if (handleUnauthenticatedApiError(requestError)) return;
        reportRequestError(requestError, "Episode");
      } finally {
        requestingTranscriptMediaIds.remove(mediaId);
      }
    },
    [
      onMutationCommitted,
      reload,
      reportRequestError,
      requestingTranscriptMediaIds,
      setEpisodes,
      setError,
      transcriptReasonByMediaId,
    ],
  );

  if (asyncDefect !== null) throw asyncDefect.error;

  return {
    batchTranscriptBusy,
    batchTranscriptSummary,
    expandedTranscriptMediaIds,
    requestingTranscriptMediaIds,
    transcriptReasonByMediaId,
    setTranscriptReasonByMediaId,
    handleBatchTranscriptRequest,
    handleRequestTranscript,
  };
}
