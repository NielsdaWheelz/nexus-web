"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch, isApiError } from "@/lib/api/client";
import { usePaneParam, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import PageLayout from "@/components/ui/PageLayout";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

const EPISODES_PAGE_SIZE = 100;
const LIBRARY_MEDIA_PAGE_SIZE = 200;
const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;
const TRANSCRIPT_FORECAST_BATCH_SIZE = 100;

type TranscriptRequestReason = "search" | "highlight" | "quote";
type EpisodeTranscriptState =
  | "not_requested"
  | "queued"
  | "running"
  | "failed_provider"
  | "failed_quota"
  | "unavailable"
  | "ready"
  | "partial"
  | null;
type EpisodeTranscriptCoverage = "none" | "partial" | "full" | null;

interface PodcastDetailItem {
  id: string;
  provider: string;
  provider_podcast_id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface PodcastSubscription {
  user_id: string;
  podcast_id: string;
  status: "active" | "unsubscribed";
  unsubscribe_mode: 1 | 2 | 3;
  sync_status: "pending" | "running" | "partial" | "complete" | "source_limited" | "failed";
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
}

interface PodcastDetailResponse {
  podcast: PodcastDetailItem;
  subscription: PodcastSubscription;
}

interface MediaCapabilities {
  can_read: boolean;
  can_highlight: boolean;
  can_quote: boolean;
  can_search: boolean;
  can_play: boolean;
  can_download_file: boolean;
}

interface PodcastEpisodeMedia {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  processing_status: string;
  transcript_state: EpisodeTranscriptState;
  transcript_coverage: EpisodeTranscriptCoverage;
  failure_stage: string | null;
  last_error_code: string | null;
  playback_source:
    | {
        kind: "external_audio" | "external_video";
        stream_url: string;
        source_url: string;
      }
    | null;
  capabilities: MediaCapabilities;
  authors: Array<{ id: string; name: string; role: string | null }>;
  published_date: string | null;
  publisher: string | null;
  language: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface MeResponse {
  user_id: string;
  default_library_id: string;
}

interface LibraryMediaSummary {
  id: string;
}

interface PodcastSubscriptionSyncRefreshResult {
  podcast_id: string;
  sync_status: PodcastSubscription["sync_status"];
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_enqueued: boolean;
}

interface TranscriptRequestResult {
  media_id: string;
  processing_status: string;
  transcript_state: EpisodeTranscriptState;
  transcript_coverage: EpisodeTranscriptCoverage;
  required_minutes: number;
  remaining_minutes: number | null;
  fits_budget: boolean;
  request_enqueued: boolean;
}

interface TranscriptForecastBatchRequest {
  requests: Array<{
    media_id: string;
    reason: TranscriptRequestReason;
  }>;
}

interface TranscriptForecastBatchResponse {
  data: TranscriptRequestResult[];
}

interface TranscriptRequestForecastState {
  required_minutes: number;
  remaining_minutes: number | null;
  fits_budget: boolean;
  request_enqueued: boolean;
  reason: TranscriptRequestReason;
  source: "forecast" | "request";
}

function formatEpisodeTranscriptMeta(episode: PodcastEpisodeMedia): string {
  const state = episode.transcript_state ?? "unknown";
  const coverage = episode.transcript_coverage ?? "unknown";
  return `transcript ${state} (${coverage} coverage)`;
}

function canRequestTranscriptForEpisode(episode: PodcastEpisodeMedia): boolean {
  const transcriptState = episode.transcript_state;
  if (transcriptState === null) {
    return false;
  }
  return !(
    transcriptState === "queued" ||
    transcriptState === "running" ||
    transcriptState === "ready" ||
    transcriptState === "partial" ||
    transcriptState === "unavailable"
  );
}

function shouldPollTranscriptProvisioningForEpisode(episode: PodcastEpisodeMedia): boolean {
  return (
    episode.transcript_state === "queued" ||
    episode.transcript_state === "running" ||
    episode.processing_status === "extracting"
  );
}

function applyTranscriptResponseToEpisode(
  episode: PodcastEpisodeMedia,
  response: Pick<
    TranscriptRequestResult,
    "processing_status" | "transcript_state" | "transcript_coverage"
  >
): PodcastEpisodeMedia {
  return {
    ...episode,
    processing_status: response.processing_status,
    transcript_state: response.transcript_state,
    transcript_coverage: response.transcript_coverage,
  };
}

function toTranscriptForecastState(
  response: TranscriptRequestResult,
  reason: TranscriptRequestReason,
  source: "forecast" | "request"
): TranscriptRequestForecastState {
  return {
    required_minutes: response.required_minutes,
    remaining_minutes: response.remaining_minutes,
    fits_budget: response.fits_budget,
    request_enqueued: response.request_enqueued,
    reason,
    source,
  };
}

export default function PodcastDetailPage() {
  const podcastId = usePaneParam("podcastId");
  const { addToQueue, queueItems } = useGlobalPlayer();
  const [detail, setDetail] = useState<PodcastDetailResponse | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisodeMedia[]>([]);
  const [hasMoreEpisodes, setHasMoreEpisodes] = useState(false);
  const [loadingMoreEpisodes, setLoadingMoreEpisodes] = useState(false);
  const [defaultLibraryId, setDefaultLibraryId] = useState<string | null>(null);
  const [libraryMediaIds, setLibraryMediaIds] = useState<Set<string>>(new Set());
  const [busyMediaIds, setBusyMediaIds] = useState<Set<string>>(new Set());
  const [requestingTranscriptMediaIds, setRequestingTranscriptMediaIds] = useState<Set<string>>(
    new Set()
  );
  const forecastingTranscriptMediaIdsRef = useRef<Set<string>>(new Set());
  const [transcriptRequestForecastByMediaId, setTranscriptRequestForecastByMediaId] = useState<
    Record<string, TranscriptRequestForecastState>
  >({});
  const [transcriptReasonByMediaId, setTranscriptReasonByMediaId] = useState<
    Record<string, TranscriptRequestReason>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsubscribeBusy, setUnsubscribeBusy] = useState(false);
  const [refreshSyncBusy, setRefreshSyncBusy] = useState(false);
  const [unsubscribeMode, setUnsubscribeMode] = useState<1 | 2 | 3>(1);

  useSetPaneTitle(detail?.podcast.title ?? "Podcast");

  const loadAllLibraryMediaIds = useCallback(async (libraryId: string): Promise<Set<string>> => {
    const collected = new Set<string>();
    let offset = 0;
    while (true) {
      const response = await apiFetch<{ data: LibraryMediaSummary[] }>(
        `/api/libraries/${libraryId}/media?limit=${LIBRARY_MEDIA_PAGE_SIZE}&offset=${offset}`
      );
      for (const item of response.data) {
        collected.add(item.id);
      }
      if (response.data.length < LIBRARY_MEDIA_PAGE_SIZE) {
        break;
      }
      offset += LIBRARY_MEDIA_PAGE_SIZE;
    }
    return collected;
  }, []);

  const load = useCallback(async () => {
    if (!podcastId) {
      setLoading(false);
      setError("Podcast id is missing");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [detailResp, episodesResp, meResp] = await Promise.all([
        apiFetch<{ data: PodcastDetailResponse }>(`/api/podcasts/${podcastId}`),
        apiFetch<{ data: PodcastEpisodeMedia[] }>(
          `/api/podcasts/${podcastId}/episodes?limit=${EPISODES_PAGE_SIZE}&offset=0`
        ),
        apiFetch<{ data: MeResponse }>("/api/me"),
      ]);
      setDetail(detailResp.data);
      setEpisodes(episodesResp.data);
      setHasMoreEpisodes(episodesResp.data.length === EPISODES_PAGE_SIZE);
      forecastingTranscriptMediaIdsRef.current.clear();
      setTranscriptRequestForecastByMediaId({});
      setDefaultLibraryId(meResp.data.default_library_id);
      setUnsubscribeMode(detailResp.data.subscription.unsubscribe_mode);

      if (meResp.data.default_library_id) {
        const libraryIds = await loadAllLibraryMediaIds(meResp.data.default_library_id);
        setLibraryMediaIds(libraryIds);
      } else {
        setLibraryMediaIds(new Set());
      }
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError("Failed to load podcast detail");
      }
    } finally {
      setLoading(false);
    }
  }, [loadAllLibraryMediaIds, podcastId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAddToLibrary = useCallback(
    async (mediaId: string) => {
      if (!defaultLibraryId) {
        return;
      }
      setBusyMediaIds((prev) => new Set(prev).add(mediaId));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${defaultLibraryId}/media`, {
          method: "POST",
          body: JSON.stringify({ media_id: mediaId }),
        });
        setLibraryMediaIds((prev) => new Set(prev).add(mediaId));
      } catch (mutationError) {
        if (isApiError(mutationError)) {
          setError(mutationError.message);
        } else {
          setError("Failed to add episode to library");
        }
      } finally {
        setBusyMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [defaultLibraryId]
  );

  const handleRemoveFromLibrary = useCallback(
    async (mediaId: string) => {
      if (!defaultLibraryId) {
        return;
      }
      setBusyMediaIds((prev) => new Set(prev).add(mediaId));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${defaultLibraryId}/media/${mediaId}`, {
          method: "DELETE",
        });
        setLibraryMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      } catch (mutationError) {
        if (isApiError(mutationError)) {
          setError(mutationError.message);
        } else {
          setError("Failed to remove episode from library");
        }
      } finally {
        setBusyMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [defaultLibraryId]
  );

  const handleLoadMoreEpisodes = useCallback(async () => {
    if (!podcastId || loadingMoreEpisodes || !hasMoreEpisodes) {
      return;
    }
    setLoadingMoreEpisodes(true);
    setError(null);
    try {
      const response = await apiFetch<{ data: PodcastEpisodeMedia[] }>(
        `/api/podcasts/${podcastId}/episodes?limit=${EPISODES_PAGE_SIZE}&offset=${episodes.length}`
      );
      setEpisodes((prev) => [...prev, ...response.data]);
      setHasMoreEpisodes(response.data.length === EPISODES_PAGE_SIZE);
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError("Failed to load more podcast episodes");
      }
    } finally {
      setLoadingMoreEpisodes(false);
    }
  }, [episodes.length, hasMoreEpisodes, loadingMoreEpisodes, podcastId]);

  const handleRefreshSync = useCallback(async () => {
    if (!podcastId) {
      return;
    }
    setRefreshSyncBusy(true);
    setError(null);
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionSyncRefreshResult }>(
        `/api/podcasts/subscriptions/${podcastId}/sync`,
        { method: "POST" }
      );
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              subscription: {
                ...prev.subscription,
                sync_status: response.data.sync_status,
                sync_error_code: response.data.sync_error_code,
                sync_error_message: response.data.sync_error_message,
                sync_attempts: response.data.sync_attempts,
              },
            }
          : prev
      );
      await load();
    } catch (refreshError) {
      if (isApiError(refreshError)) {
        setError(refreshError.message);
      } else {
        setError("Failed to refresh podcast sync");
      }
    } finally {
      setRefreshSyncBusy(false);
    }
  }, [load, podcastId]);

  const handleUnsubscribe = useCallback(async () => {
    if (!podcastId) {
      return;
    }
    setUnsubscribeBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/podcasts/subscriptions/${podcastId}?mode=${unsubscribeMode}`, {
        method: "DELETE",
      });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              subscription: {
                ...prev.subscription,
                status: "unsubscribed",
                unsubscribe_mode: unsubscribeMode,
              },
            }
          : prev
      );
    } catch (unsubscribeError) {
      if (isApiError(unsubscribeError)) {
        setError(unsubscribeError.message);
      } else {
        setError("Failed to unsubscribe from podcast");
      }
    } finally {
      setUnsubscribeBusy(false);
    }
  }, [podcastId, unsubscribeMode]);

  const refreshEpisodeStates = useCallback(async (mediaIds: string[]) => {
    if (mediaIds.length === 0) {
      return;
    }
    const uniqueMediaIds = [...new Set(mediaIds)];
    const refreshResults = await Promise.allSettled(
      uniqueMediaIds.map((mediaId) =>
        apiFetch<{ data: PodcastEpisodeMedia }>(`/api/media/${mediaId}`)
      )
    );
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
        return refreshed ? { ...episode, ...refreshed } : episode;
      })
    );
  }, []);

  const refreshEpisodeState = useCallback(
    async (mediaId: string) => {
      await refreshEpisodeStates([mediaId]);
    },
    [refreshEpisodeStates]
  );

  const applyTranscriptForecasts = useCallback(
    (
      results: TranscriptRequestResult[],
      requests: Array<{
        media_id: string;
        reason: TranscriptRequestReason;
      }>
    ) => {
      const reasonByMediaId = new Map(requests.map((request) => [request.media_id, request.reason]));
      const resultByMediaId = new Map(
        results.map((result) => [result.media_id, result] satisfies [string, TranscriptRequestResult])
      );

      setEpisodes((prev) =>
        prev.map((episode) => {
          const forecast = resultByMediaId.get(episode.id);
          return forecast ? applyTranscriptResponseToEpisode(episode, forecast) : episode;
        })
      );
      setTranscriptRequestForecastByMediaId((prev) => {
        const next = { ...prev };
        for (const result of results) {
          const reason = reasonByMediaId.get(result.media_id) ?? "search";
          next[result.media_id] = toTranscriptForecastState(result, reason, "forecast");
        }
        return next;
      });
    },
    []
  );

  const fetchTranscriptForecasts = useCallback(
    async (
      requests: Array<{
        media_id: string;
        reason: TranscriptRequestReason;
      }>
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
        }
      );
      return response.data;
    },
    []
  );

  const provisioningEpisodeIds = useMemo(
    () =>
      episodes
        .filter((episode) => shouldPollTranscriptProvisioningForEpisode(episode))
        .map((episode) => episode.id),
    [episodes]
  );

  useEffect(() => {
    if (provisioningEpisodeIds.length === 0) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) {
        return;
      }
      void refreshEpisodeStates(provisioningEpisodeIds).catch(() => {
        // Keep rows responsive even when one poll cycle fails.
      });
    }, TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [provisioningEpisodeIds, refreshEpisodeStates]);

  useEffect(() => {
    const pendingForecastEpisodes = episodes
      .filter((episode) => canRequestTranscriptForEpisode(episode))
      .filter((episode) => {
        if (requestingTranscriptMediaIds.has(episode.id)) {
          return false;
        }
        if (forecastingTranscriptMediaIdsRef.current.has(episode.id)) {
          return false;
        }
        const reason = transcriptReasonByMediaId[episode.id] ?? "search";
        const existingForecast = transcriptRequestForecastByMediaId[episode.id];
        return !existingForecast || existingForecast.reason !== reason;
      })
      .slice(0, TRANSCRIPT_FORECAST_BATCH_SIZE);

    if (pendingForecastEpisodes.length === 0) {
      return;
    }

    let cancelled = false;
    const pendingForecastRequests = pendingForecastEpisodes.map((episode) => ({
      media_id: episode.id,
      reason: transcriptReasonByMediaId[episode.id] ?? "search",
    }));
    for (const request of pendingForecastRequests) {
      forecastingTranscriptMediaIdsRef.current.add(request.media_id);
    }

    const loadForecasts = async () => {
      try {
        const results = await fetchTranscriptForecasts(pendingForecastRequests);
        if (cancelled) {
          return;
        }
        applyTranscriptForecasts(results, pendingForecastRequests);
      } catch {
        // Keep CTA enabled when forecast preflight fails.
      } finally {
        for (const request of pendingForecastRequests) {
          forecastingTranscriptMediaIdsRef.current.delete(request.media_id);
        }
      }
    };

    void loadForecasts();
    return () => {
      cancelled = true;
      for (const request of pendingForecastRequests) {
        forecastingTranscriptMediaIdsRef.current.delete(request.media_id);
      }
    };
  }, [
    applyTranscriptForecasts,
    episodes,
    fetchTranscriptForecasts,
    requestingTranscriptMediaIds,
    transcriptReasonByMediaId,
    transcriptRequestForecastByMediaId,
  ]);

  const handleRequestTranscript = useCallback(
    async (mediaId: string) => {
      const reason = transcriptReasonByMediaId[mediaId] ?? "search";
      setRequestingTranscriptMediaIds((prev) => new Set(prev).add(mediaId));
      setError(null);
      try {
        let forecast = transcriptRequestForecastByMediaId[mediaId];
        if (!forecast || forecast.reason !== reason) {
          const forecastResults = await fetchTranscriptForecasts([{ media_id: mediaId, reason }]);
          applyTranscriptForecasts(forecastResults, [{ media_id: mediaId, reason }]);
          const payload = forecastResults[0];
          if (!payload) {
            return;
          }
          const nextForecast = toTranscriptForecastState(payload, reason, "forecast");
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
          }
        );
        const payload = response.data;
        setEpisodes((prev) =>
          prev.map((episode) =>
            episode.id === mediaId ? applyTranscriptResponseToEpisode(episode, payload) : episode
          )
        );
        setTranscriptRequestForecastByMediaId((prev) => ({
          ...prev,
          [mediaId]: toTranscriptForecastState(payload, reason, "request"),
        }));
        try {
          await refreshEpisodeState(mediaId);
        } catch {
          // Keep optimistic row state if one refresh fails; polling continues.
        }
      } catch (requestError) {
        if (isApiError(requestError)) {
          setError(requestError.message);
        } else {
          setError("Failed to request transcript");
        }
      } finally {
        setRequestingTranscriptMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [
      applyTranscriptForecasts,
      fetchTranscriptForecasts,
      refreshEpisodeState,
      transcriptReasonByMediaId,
      transcriptRequestForecastByMediaId,
    ]
  );

  const activeEpisodeCount = useMemo(() => episodes.length, [episodes]);
  const queueMediaIds = useMemo(() => {
    return new Set(queueItems.map((item) => item.media_id));
  }, [queueItems]);

  if (!podcastId) {
    return (
      <PageLayout title="Podcast" description="Podcast detail is unavailable.">
        <StateMessage variant="error">Podcast id is missing.</StateMessage>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title={detail?.podcast.title ?? "Podcast"}
      description={detail?.podcast.author || detail?.podcast.description || "Podcast detail"}
      actions={
        <Link href="/podcasts/subscriptions" className={styles.navLink}>
          My podcasts
        </Link>
      }
    >
      <SectionCard
        title="Subscription"
        description={detail?.podcast.feed_url || "Podcast subscription state"}
        actions={
          detail ? (
            <div className={styles.subscriptionActions}>
              <button
                type="button"
                className={styles.syncButton}
                onClick={() => void handleRefreshSync()}
                disabled={refreshSyncBusy}
                aria-label={`Refresh sync for ${detail.podcast.title}`}
              >
                {refreshSyncBusy ? "Refreshing..." : "Refresh sync"}
              </button>
              {detail.subscription.status === "active" ? (
                <>
                  <label className={styles.unsubscribeModeLabel}>
                    Unsubscribe behavior
                    <select
                      value={String(unsubscribeMode)}
                      onChange={(event) =>
                        setUnsubscribeMode(Number(event.target.value) as 1 | 2 | 3)
                      }
                      className={styles.unsubscribeModeSelect}
                      aria-label="Unsubscribe behavior"
                    >
                      <option value="1">Keep episodes in libraries</option>
                      <option value="2">Remove from default library</option>
                      <option value="3">Remove from default and single-member libraries</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className={styles.unsubscribeButton}
                    onClick={() => void handleUnsubscribe()}
                    disabled={unsubscribeBusy}
                    aria-label={`Unsubscribe from ${detail.podcast.title}`}
                  >
                    {unsubscribeBusy ? "Unsubscribing..." : "Unsubscribe"}
                  </button>
                </>
              ) : (
                <span className={styles.unsubscribedLabel}>Unsubscribed</span>
              )}
            </div>
          ) : null
        }
      >
        {loading && <StateMessage variant="loading">Loading podcast detail...</StateMessage>}
        {error && <StateMessage variant="error">{error}</StateMessage>}
        {!loading && detail && (
          <>
            <p className={styles.syncState}>
              sync status: <strong>{detail.subscription.sync_status}</strong>
            </p>
            {detail.subscription.sync_error_code && (
              <p className={styles.syncError}>
                <strong>{detail.subscription.sync_error_code}</strong>
                {detail.subscription.sync_error_message
                  ? `: ${detail.subscription.sync_error_message}`
                  : ""}
              </p>
            )}
          </>
        )}
      </SectionCard>

      <SectionCard title="Episodes" actions={<span>{activeEpisodeCount} episodes</span>}>
        {!loading && episodes.length === 0 && !error && (
          <StateMessage variant="empty">No episodes found for this podcast.</StateMessage>
        )}

        {episodes.length > 0 && (
          <AppList>
            {episodes.map((episode) => {
              const inLibrary = libraryMediaIds.has(episode.id);
              const busy = busyMediaIds.has(episode.id);
              const canRequestTranscript = canRequestTranscriptForEpisode(episode);
              const transcriptProvisioningInProgress =
                shouldPollTranscriptProvisioningForEpisode(episode);
              const transcriptReason = transcriptReasonByMediaId[episode.id] ?? "search";
              const transcriptRequestForecast = transcriptRequestForecastByMediaId[episode.id];
              const forecastForSelectedReason =
                transcriptRequestForecast && transcriptRequestForecast.reason === transcriptReason
                  ? transcriptRequestForecast
                  : null;
              const transcriptRequestDisabled =
                requestingTranscriptMediaIds.has(episode.id) ||
                (forecastForSelectedReason ? !forecastForSelectedReason.fits_budget : false);
              const actionLabel = inLibrary
                ? `Remove ${episode.title} from library`
                : `Add ${episode.title} to library`;
              const inQueue = queueMediaIds.has(episode.id);
              return (
                <AppListItem
                  key={episode.id}
                  href={`/media/${episode.id}`}
                  title={episode.title}
                  description={episode.capabilities.can_play ? "Playable episode" : "Processing"}
                  meta={`${episode.processing_status} · ${formatEpisodeTranscriptMeta(episode)}`}
                  actions={
                    <div className={styles.episodeActions}>
                      <button
                        type="button"
                        className={styles.queueButton}
                        aria-label={`Play next for ${episode.title}`}
                        onClick={() => {
                          void addToQueue(episode.id, "next");
                        }}
                      >
                        Play next
                      </button>
                      <button
                        type="button"
                        className={styles.queueButton}
                        aria-label={`Add ${episode.title} to queue`}
                        onClick={() => {
                          void addToQueue(episode.id, "last");
                        }}
                      >
                        Add to queue
                      </button>
                      {inQueue && <span className={styles.queueBadge}>In Queue</span>}
                      {canRequestTranscript ? (
                        <>
                          <label className={styles.reasonLabel}>
                            Transcript reason
                            <select
                              value={transcriptReason}
                              onChange={(event) =>
                                setTranscriptReasonByMediaId((prev) => ({
                                  ...prev,
                                  [episode.id]: event.target.value as TranscriptRequestReason,
                                }))
                              }
                              aria-label={`Transcript request reason for ${episode.title}`}
                              className={styles.reasonSelect}
                            >
                              <option value="search">search</option>
                              <option value="highlight">highlight</option>
                              <option value="quote">quote</option>
                            </select>
                          </label>
                          <button
                            type="button"
                            className={styles.requestButton}
                            aria-label={`Request transcript for ${episode.title}`}
                            disabled={transcriptRequestDisabled}
                            onClick={() => void handleRequestTranscript(episode.id)}
                          >
                            {requestingTranscriptMediaIds.has(episode.id)
                              ? "Requesting..."
                              : "Request transcript"}
                          </button>
                        </>
                      ) : (
                        <span className={styles.transcriptStatus}>
                          {episode.transcript_state === "ready"
                            ? "Transcript ready"
                            : episode.transcript_state === "partial"
                              ? "Transcript partially ready"
                              : transcriptProvisioningInProgress
                                ? "Transcript request in progress"
                                : episode.transcript_state === "unavailable"
                                  ? "Transcript unavailable"
                                  : "Transcript state unavailable"}
                        </span>
                      )}
                      <button
                        type="button"
                        className={styles.libraryButton}
                        aria-label={actionLabel}
                        disabled={busy || !defaultLibraryId}
                        onClick={() =>
                          void (inLibrary
                            ? handleRemoveFromLibrary(episode.id)
                            : handleAddToLibrary(episode.id))
                        }
                      >
                        {busy ? "Saving..." : inLibrary ? "Remove from library" : "Add to library"}
                      </button>
                      {canRequestTranscript && forecastForSelectedReason && (
                        <span className={styles.transcriptRequestHint}>
                          {forecastForSelectedReason.source === "request"
                            ? forecastForSelectedReason.request_enqueued
                              ? "queued"
                              : "acknowledged"
                            : "estimate"}{" "}
                          · {forecastForSelectedReason.required_minutes} min · remaining{" "}
                          {forecastForSelectedReason.remaining_minutes == null
                            ? "unlimited"
                            : `${forecastForSelectedReason.remaining_minutes} min`}
                        </span>
                      )}
                      {canRequestTranscript &&
                        forecastForSelectedReason &&
                        !forecastForSelectedReason.fits_budget && (
                          <span className={styles.transcriptQuotaWarning}>
                            Not enough daily quota for this request.
                          </span>
                        )}
                    </div>
                  }
                />
              );
            })}
          </AppList>
        )}

        {!loading && hasMoreEpisodes && (
          <button
            type="button"
            className={styles.loadMoreButton}
            onClick={() => void handleLoadMoreEpisodes()}
            disabled={loadingMoreEpisodes}
            aria-label="Load more episodes"
          >
            {loadingMoreEpisodes ? "Loading..." : "Load more episodes"}
          </button>
        )}
      </SectionCard>
    </PageLayout>
  );
}
