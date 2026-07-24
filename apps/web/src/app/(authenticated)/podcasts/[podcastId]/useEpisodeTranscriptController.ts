"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { useStringIdSet } from "@/lib/useStringIdSet";
import {
  TRANSCRIPT_FORECAST_BATCH_SIZE,
  TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS,
  applyTranscriptResponseToEpisode,
  canRequestTranscriptForEpisode,
  deriveEpisodeState,
  shouldPollTranscriptProvisioningForEpisode,
  summarizeBatchTranscriptResults,
  toTranscriptForecastState,
  type PodcastEpisodeMedia,
  type TranscriptBatchRequest,
  type TranscriptBatchResponse,
  type TranscriptForecastBatchRequest,
  type TranscriptForecastBatchResponse,
  type TranscriptRequestReason,
  type TranscriptRequestForecastState,
  type TranscriptRequestResult,
} from "./episodeTranscript";

interface UseEpisodeTranscriptControllerArgs {
  episodes: PodcastEpisodeMedia[];
  setEpisodes: Dispatch<SetStateAction<PodcastEpisodeMedia[]>>;
  transcriptionAllowed: boolean;
  setError: (feedback: FeedbackContent | null) => void;
  reload: () => void;
  onMutationCommitted: () => void;
}

/**
 * Owns the episode-transcript subsystem for the podcast-detail pane: per-episode
 * forecast/reason/request state, the forecast-prefetch effect, the provisioning
 * poll, and the batch + single transcript-request handlers. It reads/writes the
 * pane's `episodes` list and reports failures through `setError`; a successful
 * batch request triggers `reload` to refresh the pane.
 */
export function useEpisodeTranscriptController({
  episodes,
  setEpisodes,
  transcriptionAllowed,
  setError,
  reload,
  onMutationCommitted,
}: UseEpisodeTranscriptControllerArgs) {
  const [batchTranscriptBusy, setBatchTranscriptBusy] = useState(false);
  const [batchTranscriptSummary, setBatchTranscriptSummary] = useState<
    string | null
  >(null);
  const expandedTranscriptMediaIds = useStringIdSet();
  const requestingTranscriptMediaIds = useStringIdSet();
  const mountedRef = useRef(true);
  const forecastingTranscriptRequestKeysRef = useRef<Set<string>>(new Set());
  const [forecastSettledVersion, setForecastSettledVersion] = useState(0);
  const [
    transcriptRequestForecastByMediaId,
    setTranscriptRequestForecastByMediaId,
  ] = useState<Record<string, TranscriptRequestForecastState>>({});
  const [transcriptReasonByMediaId, setTranscriptReasonByMediaId] = useState<
    Record<string, TranscriptRequestReason>
  >({});

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Reset per-episode forecast state when the underlying episode set is
  // replaced (route change / reload). The pane clears `episodes` then refills it.
  const resetForecasts = useCallback(() => {
    setTranscriptRequestForecastByMediaId({});
  }, []);

  const refreshEpisodeStates = useCallback(
    async (mediaIds: string[]) => {
      if (mediaIds.length === 0) {
        return;
      }
      const uniqueMediaIds = [...new Set(mediaIds)];
      const refreshResults = await Promise.allSettled(
        uniqueMediaIds.map((mediaId) =>
          apiFetch<{ data: PodcastEpisodeMedia }>(`/api/media/${mediaId}`),
        ),
      );
      if (
        refreshResults.some(
          (result) =>
            result.status === "rejected" &&
            handleUnauthenticatedApiError(result.reason),
        )
      ) {
        return;
      }
      const refreshedByMediaId = new Map<string, PodcastEpisodeMedia>();
      refreshResults.forEach((result, index) => {
        if (result.status !== "fulfilled") {
          return;
        }
        refreshedByMediaId.set(uniqueMediaIds[index], result.value.data);
      });
      if (refreshedByMediaId.size === 0) {
        return;
      }
      setEpisodes((prev) =>
        prev.map((episode) => {
          const refreshed = refreshedByMediaId.get(episode.id);
          return refreshed
            ? {
                ...episode,
                ...refreshed,
                episode_state: refreshed.episode_state ?? episode.episode_state,
              }
            : episode;
        }),
      );
    },
    [setEpisodes],
  );

  const refreshEpisodeState = useCallback(
    async (mediaId: string) => {
      await refreshEpisodeStates([mediaId]);
    },
    [refreshEpisodeStates],
  );

  const batchTranscriptCandidateEpisodes = useMemo(
    () =>
      episodes.filter((episode) => {
        const episodeState = deriveEpisodeState(episode);
        return (
          transcriptionAllowed &&
          (episodeState === "unplayed" || episodeState === "in_progress") &&
          canRequestTranscriptForEpisode(episode)
        );
      }),
    [episodes, transcriptionAllowed],
  );

  const handleBatchTranscriptRequest = useCallback(async () => {
    if (batchTranscriptCandidateEpisodes.length === 0) {
      return;
    }

    const requiredMinutes = batchTranscriptCandidateEpisodes.reduce(
      (total, episode) => {
        const forecast = transcriptRequestForecastByMediaId[episode.id];
        return total + (forecast?.required_minutes ?? 1);
      },
      0,
    );
    const remainingQuotaValues = batchTranscriptCandidateEpisodes
      .map(
        (episode) =>
          transcriptRequestForecastByMediaId[episode.id]?.remaining_minutes,
      )
      .filter((value): value is number => typeof value === "number");
    const remainingQuota =
      remainingQuotaValues.length > 0
        ? Math.min(...remainingQuotaValues)
        : null;
    const fitsBudget =
      remainingQuota == null || requiredMinutes <= remainingQuota;
    const confirmationMessage = [
      `Eligible episodes: ${batchTranscriptCandidateEpisodes.length}`,
      `Estimated minutes: ${requiredMinutes}`,
      `Remaining quota: ${remainingQuota ?? 0}`,
      `Fits budget: ${fitsBudget ? "yes" : "no"}`,
      "",
      "Submit batch transcript request?",
    ].join("\n");
    if (!window.confirm(confirmationMessage)) {
      return;
    }

    setBatchTranscriptBusy(true);
    setError(null);
    try {
      const payload: TranscriptBatchRequest = {
        media_ids: batchTranscriptCandidateEpisodes.map((episode) => episode.id),
        reason: "search",
      };
      const response = await apiFetch<TranscriptBatchResponse>(
        "/api/media/transcript/request/batch",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
      setBatchTranscriptSummary(
        summarizeBatchTranscriptResults(response.data.results),
      );
      reload();
    } catch (requestError) {
      if (handleUnauthenticatedApiError(requestError)) return;
      setError(
        toFeedback(requestError, {
          fallback: "Failed to request batch transcripts",
        }),
      );
    } finally {
      setBatchTranscriptBusy(false);
    }
  }, [
    batchTranscriptCandidateEpisodes,
    reload,
    setError,
    transcriptRequestForecastByMediaId,
  ]);

  const applyTranscriptForecasts = useCallback(
    (
      results: TranscriptRequestResult[],
      requests: Array<{
        media_id: string;
        reason: TranscriptRequestReason;
      }>,
    ) => {
      const reasonByMediaId = new Map(
        requests.map((request) => [request.media_id, request.reason]),
      );
      const resultByMediaId = new Map(
        results.map(
          (result) =>
            [result.media_id, result] satisfies [
              string,
              TranscriptRequestResult,
            ],
        ),
      );

      setEpisodes((prev) =>
        prev.map((episode) => {
          const forecast = resultByMediaId.get(episode.id);
          return forecast
            ? applyTranscriptResponseToEpisode(episode, forecast)
            : episode;
        }),
      );
      setTranscriptRequestForecastByMediaId((prev) => {
        const next = { ...prev };
        for (const result of results) {
          const reason = reasonByMediaId.get(result.media_id) ?? "search";
          next[result.media_id] = toTranscriptForecastState(
            result,
            reason,
            "forecast",
          );
        }
        return next;
      });
    },
    [setEpisodes],
  );

  const fetchTranscriptForecasts = useCallback(
    async (
      requests: Array<{
        media_id: string;
        reason: TranscriptRequestReason;
      }>,
    ) => {
      if (requests.length === 0) {
        return [] as TranscriptRequestResult[];
      }

      const response = await apiFetch<TranscriptForecastBatchResponse>(
        "/api/media/transcript/forecasts",
        {
          method: "POST",
          body: JSON.stringify({
            requests,
          } satisfies TranscriptForecastBatchRequest),
        },
      );
      return response.data;
    },
    [],
  );

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
      await refreshEpisodeStates(provisioningEpisodeIds).catch((error) => {
        handleUnauthenticatedApiError(error);
      });
    },
    pollIntervalMs: TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    const pendingForecastEpisodes = episodes
      .filter((episode) => canRequestTranscriptForEpisode(episode))
      .filter((episode) => {
        if (requestingTranscriptMediaIds.ids.has(episode.id)) {
          return false;
        }
        const reason = transcriptReasonByMediaId[episode.id] ?? "search";
        if (
          forecastingTranscriptRequestKeysRef.current.has(
            `${episode.id}:${reason}`,
          )
        ) {
          return false;
        }
        const existingForecast = transcriptRequestForecastByMediaId[episode.id];
        return !existingForecast || existingForecast.reason !== reason;
      })
      .slice(0, TRANSCRIPT_FORECAST_BATCH_SIZE);

    if (pendingForecastEpisodes.length === 0) {
      return;
    }

    const forecastingSet = forecastingTranscriptRequestKeysRef.current;
    let cancelled = false;
    const pendingForecastRequests = pendingForecastEpisodes.map((episode) => ({
      media_id: episode.id,
      reason: transcriptReasonByMediaId[episode.id] ?? "search",
    }));
    const pendingForecastKeys = pendingForecastRequests.map(
      (request) => `${request.media_id}:${request.reason}`,
    );
    for (const key of pendingForecastKeys) {
      forecastingSet.add(key);
    }

    const loadForecasts = async () => {
      try {
        const results = await fetchTranscriptForecasts(pendingForecastRequests);
        if (cancelled) {
          return;
        }
        applyTranscriptForecasts(results, pendingForecastRequests);
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        // Keep CTA enabled when forecast preflight fails.
      } finally {
        for (const key of pendingForecastKeys) {
          forecastingSet.delete(key);
        }
        if (cancelled && mountedRef.current) {
          setForecastSettledVersion((version) => version + 1);
        }
      }
    };

    void loadForecasts();
    return () => {
      cancelled = true;
    };
  }, [
    applyTranscriptForecasts,
    episodes,
    fetchTranscriptForecasts,
    forecastSettledVersion,
    requestingTranscriptMediaIds,
    transcriptReasonByMediaId,
    transcriptRequestForecastByMediaId,
  ]);

  const handleRequestTranscript = useCallback(
    async (mediaId: string) => {
      const reason = transcriptReasonByMediaId[mediaId] ?? "search";
      requestingTranscriptMediaIds.add(mediaId);
      setError(null);
      try {
        let forecast = transcriptRequestForecastByMediaId[mediaId];
        if (!forecast || forecast.reason !== reason) {
          const forecastResults = await fetchTranscriptForecasts([
            { media_id: mediaId, reason },
          ]);
          applyTranscriptForecasts(forecastResults, [
            { media_id: mediaId, reason },
          ]);
          const payload = forecastResults[0];
          if (!payload) {
            return;
          }
          const nextForecast = toTranscriptForecastState(
            payload,
            reason,
            "forecast",
          );
          forecast = nextForecast;
          setTranscriptRequestForecastByMediaId((prev) => ({
            ...prev,
            [mediaId]: nextForecast,
          }));
        }

        if (!forecast || !forecast.fits_budget) {
          return;
        }

        const response = await apiFetch<{ data: TranscriptRequestResult }>(
          `/api/media/${mediaId}/transcript/request`,
          {
            method: "POST",
            body: JSON.stringify({
              reason,
              dry_run: false,
            }),
          },
        );
        const payload = response.data;
        setEpisodes((prev) =>
          prev.map((episode) =>
            episode.id === mediaId
              ? applyTranscriptResponseToEpisode(episode, payload)
              : episode,
          ),
        );
        setTranscriptRequestForecastByMediaId((prev) => ({
          ...prev,
          [mediaId]: toTranscriptForecastState(payload, reason, "request"),
        }));
        onMutationCommitted();
        try {
          await refreshEpisodeState(mediaId);
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          // Keep optimistic row state if one refresh fails; polling continues.
        }
      } catch (requestError) {
        if (handleUnauthenticatedApiError(requestError)) return;
        setError(
          toFeedback(requestError, {
            fallback: "Failed to request transcript",
          }),
        );
      } finally {
        requestingTranscriptMediaIds.remove(mediaId);
      }
    },
    [
      applyTranscriptForecasts,
      fetchTranscriptForecasts,
      onMutationCommitted,
      refreshEpisodeState,
      requestingTranscriptMediaIds,
      setEpisodes,
      setError,
      transcriptReasonByMediaId,
      transcriptRequestForecastByMediaId,
    ],
  );

  return {
    batchTranscriptBusy,
    batchTranscriptSummary,
    batchTranscriptCandidateEpisodes,
    expandedTranscriptMediaIds,
    requestingTranscriptMediaIds,
    transcriptRequestForecastByMediaId,
    transcriptReasonByMediaId,
    setTranscriptReasonByMediaId,
    handleBatchTranscriptRequest,
    handleRequestTranscript,
    resetForecasts,
  };
}
