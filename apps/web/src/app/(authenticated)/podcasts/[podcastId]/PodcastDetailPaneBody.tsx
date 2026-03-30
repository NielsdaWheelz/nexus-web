"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
  formatSubscriptionPlaybackSummary,
} from "@/lib/player/subscriptionPlaybackSpeed";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

const EPISODES_PAGE_SIZE = 100;
const LIBRARY_MEDIA_PAGE_SIZE = 200;
const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;
const TRANSCRIPT_FORECAST_BATCH_SIZE = 100;
const EPISODE_SEARCH_DEBOUNCE_MS = 300;
const SHOW_NOTES_PREVIEW_MAX_CHARS = 280;

type TranscriptRequestReason = "search" | "highlight" | "quote";
type EpisodeState = "unplayed" | "in_progress" | "played";
type EpisodeStateFilter = "all" | EpisodeState;
type EpisodeSort = "newest" | "oldest" | "duration_asc" | "duration_desc";
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

interface PodcastSubscriptionCategoryRef {
  id: string;
  name: string;
  color: string | null;
}

interface PodcastSubscriptionCategory {
  id: string;
  name: string;
  position: number;
  color: string | null;
  created_at: string;
  subscription_count: number;
  unplayed_count: number;
}

interface PodcastSubscription {
  user_id: string;
  podcast_id: string;
  status: "active" | "unsubscribed";
  unsubscribe_mode: 1 | 2 | 3;
  default_playback_speed?: number | null;
  auto_queue?: boolean;
  category?: PodcastSubscriptionCategoryRef | null;
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
  listening_state: {
    position_ms: number;
    duration_ms: number | null;
    playback_speed: number;
    is_completed: boolean;
  } | null;
  subscription_default_playback_speed?: number | null;
  episode_state: EpisodeState | null;
  capabilities: MediaCapabilities;
  authors: Array<{ id: string; name: string; role: string | null }>;
  published_date: string | null;
  publisher: string | null;
  language: string | null;
  description: string | null;
  description_html: string | null;
  description_text: string | null;
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

interface PodcastSubscriptionSettingsResponse {
  podcast_id: string;
  default_playback_speed: number | null;
  auto_queue: boolean;
  category: PodcastSubscriptionCategoryRef | null;
  updated_at: string;
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

type TranscriptBatchStatus =
  | "queued"
  | "already_ready"
  | "already_queued"
  | "rejected_quota"
  | "rejected_invalid";

interface TranscriptBatchResult {
  media_id: string;
  status: TranscriptBatchStatus;
  required_minutes?: number | null;
  remaining_minutes?: number | null;
  error?: string | null;
}

interface TranscriptBatchRequest {
  media_ids: string[];
  reason: TranscriptRequestReason;
}

interface TranscriptBatchResponse {
  data: {
    results: TranscriptBatchResult[];
  };
}

interface TranscriptRequestForecastState {
  required_minutes: number;
  remaining_minutes: number | null;
  fits_budget: boolean;
  request_enqueued: boolean;
  reason: TranscriptRequestReason;
  source: "forecast" | "request";
}

function deriveEpisodeState(episode: PodcastEpisodeMedia): EpisodeState {
  if (episode.episode_state === "unplayed") {
    return "unplayed";
  }
  if (episode.episode_state === "in_progress") {
    return "in_progress";
  }
  if (episode.episode_state === "played") {
    return "played";
  }
  if (episode.listening_state?.is_completed) {
    return "played";
  }
  if ((episode.listening_state?.position_ms ?? 0) > 0) {
    return "in_progress";
  }
  return "unplayed";
}

function episodeMatchesFilter(episodeState: EpisodeState, filter: EpisodeStateFilter): boolean {
  return filter === "all" || episodeState === filter;
}

function formatEpisodeStateLabel(episodeState: EpisodeState): string {
  if (episodeState === "in_progress") {
    return "in progress";
  }
  return episodeState;
}

function getEpisodeProgressPercent(episode: PodcastEpisodeMedia): number {
  const listeningState = episode.listening_state;
  if (!listeningState || listeningState.duration_ms == null || listeningState.duration_ms <= 0) {
    return 0;
  }
  const rawPercent = Math.floor((listeningState.position_ms / listeningState.duration_ms) * 100);
  return Math.max(0, Math.min(100, rawPercent));
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

function summarizeBatchTranscriptResults(results: TranscriptBatchResult[]): string | null {
  if (results.length === 0) {
    return null;
  }

  let queued = 0;
  let alreadyReady = 0;
  let alreadyQueued = 0;
  let rejectedQuota = 0;
  let rejectedInvalid = 0;
  for (const result of results) {
    if (result.status === "queued") {
      queued += 1;
    } else if (result.status === "already_ready") {
      alreadyReady += 1;
    } else if (result.status === "already_queued") {
      alreadyQueued += 1;
    } else if (result.status === "rejected_quota") {
      rejectedQuota += 1;
    } else if (result.status === "rejected_invalid") {
      rejectedInvalid += 1;
    }
  }

  const parts: string[] = [];
  if (queued > 0) {
    parts.push(`${queued} queued`);
  }
  if (alreadyReady > 0) {
    parts.push(`${alreadyReady} already ready`);
  }
  if (alreadyQueued > 0) {
    parts.push(`${alreadyQueued} already queued`);
  }
  if (rejectedQuota > 0) {
    parts.push(`${rejectedQuota} rejected (quota)`);
  }
  if (rejectedInvalid > 0) {
    parts.push(`${rejectedInvalid} rejected (invalid)`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `Batch transcript result: ${parts.join(", ")}.`;
}

export default function PodcastDetailPaneBody() {
  const podcastId = usePaneParam("podcastId");
  const paneRouter = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();
  const { addToQueue, queueItems } = useGlobalPlayer();
  const [detail, setDetail] = useState<PodcastDetailResponse | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisodeMedia[]>([]);
  const [episodeStateFilter, setEpisodeStateFilter] = useState<EpisodeStateFilter>(() => {
    const stateParam = paneSearchParams.get("state");
    if (stateParam === "unplayed" || stateParam === "in_progress" || stateParam === "played") {
      return stateParam;
    }
    return "all";
  });
  const [episodeSort, setEpisodeSort] = useState<EpisodeSort>(() => {
    const sortParam = paneSearchParams.get("sort");
    if (
      sortParam === "oldest" ||
      sortParam === "duration_asc" ||
      sortParam === "duration_desc"
    ) {
      return sortParam;
    }
    return "newest";
  });
  const [episodeSearchInput, setEpisodeSearchInput] = useState(() => paneSearchParams.get("q") ?? "");
  const [episodeSearchQuery, setEpisodeSearchQuery] = useState(() => paneSearchParams.get("q") ?? "");
  const [hasMoreEpisodes, setHasMoreEpisodes] = useState(false);
  const [loadingMoreEpisodes, setLoadingMoreEpisodes] = useState(false);
  const [defaultLibraryId, setDefaultLibraryId] = useState<string | null>(null);
  const [libraryMediaIds, setLibraryMediaIds] = useState<Set<string>>(new Set());
  const [busyMediaIds, setBusyMediaIds] = useState<Set<string>>(new Set());
  const [markingEpisodeIds, setMarkingEpisodeIds] = useState<Set<string>>(new Set());
  const [markAllAsPlayedBusy, setMarkAllAsPlayedBusy] = useState(false);
  const [batchTranscriptBusy, setBatchTranscriptBusy] = useState(false);
  const [batchTranscriptSummary, setBatchTranscriptSummary] = useState<string | null>(null);
  const [expandedShowNotesMediaIds, setExpandedShowNotesMediaIds] = useState<Set<string>>(new Set());
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
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsDefaultSpeed, setSettingsDefaultSpeed] = useState<string>("default");
  const [settingsAutoQueue, setSettingsAutoQueue] = useState(false);
  const [settingsCategoryId, setSettingsCategoryId] = useState<string>("");
  const [categories, setCategories] = useState<PodcastSubscriptionCategory[]>([]);

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
      const episodeParams = new URLSearchParams({
        limit: String(EPISODES_PAGE_SIZE),
        offset: "0",
        state: episodeStateFilter,
        sort: episodeSort,
      });
      if (episodeSearchQuery.trim()) {
        episodeParams.set("q", episodeSearchQuery.trim());
      }

      const [detailResp, episodesResp, meResp, categoriesResp] = await Promise.all([
        apiFetch<{ data: PodcastDetailResponse }>(`/api/podcasts/${podcastId}`),
        apiFetch<{ data: PodcastEpisodeMedia[] }>(`/api/podcasts/${podcastId}/episodes?${episodeParams}`),
        apiFetch<{ data: MeResponse }>("/api/me"),
        apiFetch<{ data: PodcastSubscriptionCategory[] }>("/api/podcasts/categories"),
      ]);
      setDetail(detailResp.data);
      setEpisodes(episodesResp.data);
      setCategories(categoriesResp.data);
      setExpandedShowNotesMediaIds(new Set());
      setHasMoreEpisodes(episodesResp.data.length === EPISODES_PAGE_SIZE);
      forecastingTranscriptMediaIdsRef.current.clear();
      setTranscriptRequestForecastByMediaId({});
      setDefaultLibraryId(meResp.data.default_library_id);
      setUnsubscribeMode(detailResp.data.subscription.unsubscribe_mode);
      setSettingsDefaultSpeed(
        detailResp.data.subscription.default_playback_speed == null
          ? "default"
          : String(detailResp.data.subscription.default_playback_speed)
      );
      setSettingsAutoQueue(Boolean(detailResp.data.subscription.auto_queue));
      setSettingsCategoryId(detailResp.data.subscription.category?.id ?? "");
      setSettingsModalOpen(false);
      setSettingsError(null);

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
  }, [episodeSearchQuery, episodeSort, episodeStateFilter, loadAllLibraryMediaIds, podcastId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      setEpisodeSearchQuery(episodeSearchInput.trim());
    }, EPISODE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(debounceTimer);
    };
  }, [episodeSearchInput]);

  useEffect(() => {
    if (!podcastId) {
      return;
    }
    const params = new URLSearchParams();
    params.set("state", episodeStateFilter);
    params.set("sort", episodeSort);
    if (episodeSearchQuery) {
      params.set("q", episodeSearchQuery);
    }
    paneRouter.replace(`/podcasts/${podcastId}?${params.toString()}`);
  }, [episodeSearchQuery, episodeSort, episodeStateFilter, paneRouter, podcastId]);

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
      const episodeParams = new URLSearchParams({
        limit: String(EPISODES_PAGE_SIZE),
        offset: String(episodes.length),
        state: episodeStateFilter,
        sort: episodeSort,
      });
      if (episodeSearchQuery.trim()) {
        episodeParams.set("q", episodeSearchQuery.trim());
      }
      const response = await apiFetch<{ data: PodcastEpisodeMedia[] }>(
        `/api/podcasts/${podcastId}/episodes?${episodeParams}`
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
  }, [
    episodeSearchQuery,
    episodeSort,
    episodeStateFilter,
    episodes.length,
    hasMoreEpisodes,
    loadingMoreEpisodes,
    podcastId,
  ]);

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

  const openSettingsModal = useCallback(() => {
    if (!detail) {
      return;
    }
    setSettingsDefaultSpeed(
      detail.subscription.default_playback_speed == null
        ? "default"
        : String(detail.subscription.default_playback_speed)
    );
    setSettingsAutoQueue(Boolean(detail.subscription.auto_queue));
    setSettingsCategoryId(detail.subscription.category?.id ?? "");
    setSettingsError(null);
    setSettingsModalOpen(true);
  }, [detail]);

  const closeSettingsModal = useCallback(() => {
    setSettingsModalOpen(false);
    setSettingsError(null);
    setSettingsBusy(false);
  }, []);

  const handleSaveSubscriptionSettings = useCallback(async () => {
    if (!detail) {
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    setError(null);
    const nextDefaultPlaybackSpeed =
      settingsDefaultSpeed === "default" ? null : Number.parseFloat(settingsDefaultSpeed);
    const nextCategoryId = settingsCategoryId.trim();
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionSettingsResponse }>(
        `/api/podcasts/subscriptions/${detail.subscription.podcast_id}/settings`,
        {
          method: "PATCH",
          body: JSON.stringify({
            default_playback_speed: nextDefaultPlaybackSpeed,
            auto_queue: settingsAutoQueue,
            category_id: nextCategoryId.length > 0 ? nextCategoryId : null,
          }),
        }
      );
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              subscription: {
                ...prev.subscription,
                default_playback_speed: response.data.default_playback_speed,
                auto_queue: response.data.auto_queue,
                category: response.data.category,
                updated_at: response.data.updated_at ?? prev.subscription.updated_at,
              },
            }
          : prev
      );
      setEpisodes((prev) =>
        prev.map((episode) => ({
          ...episode,
          subscription_default_playback_speed: response.data.default_playback_speed,
        }))
      );
      setSettingsModalOpen(false);
    } catch (settingsUpdateError) {
      if (isApiError(settingsUpdateError)) {
        setSettingsError(settingsUpdateError.message);
      } else {
        setSettingsError("Failed to save subscription settings");
      }
    } finally {
      setSettingsBusy(false);
    }
  }, [detail, settingsAutoQueue, settingsCategoryId, settingsDefaultSpeed]);

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
        return refreshed
          ? {
              ...episode,
              ...refreshed,
              episode_state: refreshed.episode_state ?? episode.episode_state,
            }
          : episode;
      })
    );
  }, []);

  const refreshEpisodeState = useCallback(
    async (mediaId: string) => {
      await refreshEpisodeStates([mediaId]);
    },
    [refreshEpisodeStates]
  );

  const applyEpisodeCompletionState = useCallback(
    (episode: PodcastEpisodeMedia, isCompleted: boolean): PodcastEpisodeMedia => {
      const previousListeningState = episode.listening_state;
      const nextListeningState = isCompleted
        ? {
            position_ms: previousListeningState?.position_ms ?? 0,
            duration_ms: previousListeningState?.duration_ms ?? null,
            playback_speed: previousListeningState?.playback_speed ?? 1,
            is_completed: true,
          }
        : {
            position_ms: 0,
            duration_ms: previousListeningState?.duration_ms ?? null,
            playback_speed: previousListeningState?.playback_speed ?? 1,
            is_completed: false,
          };
      return {
        ...episode,
        listening_state: nextListeningState,
        episode_state: isCompleted ? "played" : "unplayed",
      };
    },
    []
  );

  const handleMarkEpisodeCompletion = useCallback(
    async (episode: PodcastEpisodeMedia, isCompleted: boolean) => {
      const mediaId = episode.id;
      setMarkingEpisodeIds((prev) => new Set(prev).add(mediaId));
      setError(null);
      const previousEpisodes = episodes;
      setEpisodes((prev) =>
        prev.flatMap((candidate) => {
          if (candidate.id !== mediaId) {
            return [candidate];
          }
          const optimisticEpisode = applyEpisodeCompletionState(candidate, isCompleted);
          if (!episodeMatchesFilter(deriveEpisodeState(optimisticEpisode), episodeStateFilter)) {
            return [];
          }
          return [optimisticEpisode];
        })
      );
      try {
        await apiFetch(`/api/media/${mediaId}/listening-state`, {
          method: "PUT",
          body: JSON.stringify(
            isCompleted
              ? {
                  is_completed: true,
                }
              : {
                  is_completed: false,
                  position_ms: 0,
                }
          ),
        });
      } catch (markError) {
        setEpisodes(previousEpisodes);
        if (isApiError(markError)) {
          setError(markError.message);
        } else {
          setError(isCompleted ? "Failed to mark episode as played" : "Failed to mark episode as unplayed");
        }
      } finally {
        setMarkingEpisodeIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [applyEpisodeCompletionState, episodeStateFilter, episodes]
  );

  const visibleUnplayedEpisodeIds = useMemo(
    () =>
      episodes
        .filter((episode) => deriveEpisodeState(episode) === "unplayed")
        .map((episode) => episode.id),
    [episodes]
  );

  const batchTranscriptCandidateEpisodes = useMemo(
    () =>
      episodes.filter((episode) => {
        const episodeState = deriveEpisodeState(episode);
        return (
          (episodeState === "unplayed" || episodeState === "in_progress") &&
          canRequestTranscriptForEpisode(episode)
        );
      }),
    [episodes]
  );

  const toggleEpisodeShowNotesExpansion = useCallback((mediaId: string) => {
    setExpandedShowNotesMediaIds((prev) => {
      const next = new Set(prev);
      if (next.has(mediaId)) {
        next.delete(mediaId);
      } else {
        next.add(mediaId);
      }
      return next;
    });
  }, []);

  const handleMarkAllVisibleUnplayedAsPlayed = useCallback(async () => {
    if (visibleUnplayedEpisodeIds.length === 0) {
      return;
    }
    if (
      !window.confirm(
        `Mark ${visibleUnplayedEpisodeIds.length} visible episode${visibleUnplayedEpisodeIds.length === 1 ? "" : "s"} as played?`
      )
    ) {
      return;
    }
    setMarkAllAsPlayedBusy(true);
    setError(null);
    const previousEpisodes = episodes;
    const targetIds = new Set(visibleUnplayedEpisodeIds);
    setEpisodes((prev) =>
      prev.flatMap((episode) => {
        if (!targetIds.has(episode.id)) {
          return [episode];
        }
        const optimisticEpisode = applyEpisodeCompletionState(episode, true);
        if (!episodeMatchesFilter(deriveEpisodeState(optimisticEpisode), episodeStateFilter)) {
          return [];
        }
        return [optimisticEpisode];
      })
    );
    try {
      await apiFetch("/api/media/listening-state/batch", {
        method: "POST",
        body: JSON.stringify({
          media_ids: visibleUnplayedEpisodeIds,
          is_completed: true,
        }),
      });
    } catch (markError) {
      setEpisodes(previousEpisodes);
      if (isApiError(markError)) {
        setError(markError.message);
      } else {
        setError("Failed to mark visible episodes as played");
      }
    } finally {
      setMarkAllAsPlayedBusy(false);
    }
  }, [
    applyEpisodeCompletionState,
    episodeStateFilter,
    episodes,
    visibleUnplayedEpisodeIds,
  ]);

  const handleBatchTranscriptRequest = useCallback(async () => {
    if (batchTranscriptCandidateEpisodes.length === 0) {
      return;
    }

    const requiredMinutes = batchTranscriptCandidateEpisodes.reduce((total, episode) => {
      const forecast = transcriptRequestForecastByMediaId[episode.id];
      return total + (forecast?.required_minutes ?? 1);
    }, 0);
    const remainingQuotaValues = batchTranscriptCandidateEpisodes
      .map((episode) => transcriptRequestForecastByMediaId[episode.id]?.remaining_minutes)
      .filter((value): value is number => typeof value === "number");
    const remainingQuota =
      remainingQuotaValues.length > 0 ? Math.min(...remainingQuotaValues) : null;
    const fitsBudget = remainingQuota == null || requiredMinutes <= remainingQuota;
    const confirmationMessage = [
      `Eligible episodes: ${batchTranscriptCandidateEpisodes.length}`,
      `Estimated minutes: ${requiredMinutes}`,
      `Remaining quota: ${remainingQuota == null ? "unlimited" : remainingQuota}`,
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
        }
      );
      setBatchTranscriptSummary(summarizeBatchTranscriptResults(response.data.results));
      await load();
    } catch (requestError) {
      if (isApiError(requestError)) {
        setError(requestError.message);
      } else {
        setError("Failed to request batch transcripts");
      }
    } finally {
      setBatchTranscriptBusy(false);
    }
  }, [batchTranscriptCandidateEpisodes, load, transcriptRequestForecastByMediaId]);

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
      <>
        <StateMessage variant="error">Podcast id is missing.</StateMessage>
      </>
    );
  }

  return (
    <>
      <div className={styles.headerActions}>
        <Link href="/podcasts/subscriptions" className={styles.navLink}>
          My podcasts
        </Link>
        <div className={styles.headerButtons}>
          <button
            type="button"
            className={styles.syncButton}
            onClick={() => void handleRefreshSync()}
            disabled={refreshSyncBusy}
          >
            {refreshSyncBusy ? "Refreshing..." : "Refresh sync"}
          </button>
          <button
            type="button"
            className={styles.syncButton}
            onClick={openSettingsModal}
            disabled={!detail}
          >
            Settings
          </button>
          {detail?.subscription.status === "active" ? (
            <button
              type="button"
              className={styles.unsubscribeButton}
              onClick={() => void handleUnsubscribe()}
              disabled={unsubscribeBusy}
            >
              {unsubscribeBusy ? "Unsubscribing..." : "Unsubscribe"}
            </button>
          ) : null}
        </div>
      </div>
      <SectionCard
        title="Subscription"
        description={detail?.podcast.feed_url || "Podcast subscription state"}
      >
        {loading && <StateMessage variant="loading">Loading podcast detail...</StateMessage>}
        {error && <StateMessage variant="error">{error}</StateMessage>}
        {!loading && detail && (
          <>
            {detail.subscription.status === "active" ? (
              <label className={styles.unsubscribeModeLabel}>
                Unsubscribe behavior
                <select
                  value={String(unsubscribeMode)}
                  onChange={(event) => setUnsubscribeMode(Number(event.target.value) as 1 | 2 | 3)}
                  className={styles.unsubscribeModeSelect}
                  aria-label="Unsubscribe behavior"
                >
                  <option value="1">Keep episodes in libraries</option>
                  <option value="2">Remove from default library</option>
                  <option value="3">Remove from default and single-member libraries</option>
                </select>
              </label>
            ) : (
              <span className={styles.unsubscribedLabel}>Unsubscribed</span>
            )}
            <p className={styles.syncState}>
              sync status: <strong>{detail.subscription.sync_status}</strong>
            </p>
            <p className={styles.settingsSummary}>
              {formatSubscriptionPlaybackSummary(
                detail.subscription.default_playback_speed,
                detail.subscription.auto_queue
              )}
            </p>
            <p className={styles.settingsSummary}>
              Category: {detail.subscription.category?.name ?? "Uncategorized"}
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

      {settingsModalOpen && detail && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Subscription settings"
        >
          <div className={styles.modalCard}>
            <h3 className={styles.modalTitle}>Subscription settings</h3>
            <p className={styles.modalDescription}>
              Configure default playback behavior for <strong>{detail.podcast.title}</strong>.
            </p>
            <label htmlFor="detail-default-playback-speed" className={styles.settingsFieldLabel}>
              Default playback speed
            </label>
            <select
              id="detail-default-playback-speed"
              className={styles.settingsSelect}
              value={settingsDefaultSpeed}
              onChange={(event) => setSettingsDefaultSpeed(event.target.value)}
              aria-label="Default playback speed"
            >
              <option value="default">Default (1.0x)</option>
              {SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={String(speed)}>
                  {formatPlaybackSpeedLabel(speed)}
                </option>
              ))}
            </select>
            <label htmlFor="detail-subscription-category" className={styles.settingsFieldLabel}>
              Subscription category
            </label>
            <select
              id="detail-subscription-category"
              className={styles.settingsSelect}
              value={settingsCategoryId}
              onChange={(event) => setSettingsCategoryId(event.target.value)}
              aria-label="Subscription category"
            >
              <option value="">Uncategorized</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <label className={styles.settingsToggleLabel}>
              <input
                type="checkbox"
                checked={settingsAutoQueue}
                onChange={(event) => setSettingsAutoQueue(event.target.checked)}
                aria-label="Automatically add new episodes to my queue"
              />
              <span>Automatically add new episodes to my queue</span>
            </label>
            <p className={styles.modalDescription}>
              New episodes from this podcast will be added to the end of your playback queue when
              they&apos;re synced.
            </p>
            {settingsError && <StateMessage variant="error">{settingsError}</StateMessage>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.syncButton}
                onClick={() => void handleSaveSubscriptionSettings()}
                disabled={settingsBusy}
                aria-label="Save subscription settings"
              >
                {settingsBusy ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className={styles.unsubscribeButton}
                onClick={closeSettingsModal}
                disabled={settingsBusy}
                aria-label="Close subscription settings"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard
        title="Episodes"
        actions={
          <div className={styles.episodeHeaderActions}>
            <span>{activeEpisodeCount} episodes</span>
            <button
              type="button"
              className={styles.batchTranscribeButton}
              onClick={() => void handleBatchTranscriptRequest()}
              disabled={batchTranscriptBusy || batchTranscriptCandidateEpisodes.length === 0}
              aria-label="Transcribe unplayed episodes"
            >
              {batchTranscriptBusy ? "Transcribing..." : "Transcribe unplayed"}
            </button>
            <button
              type="button"
              className={styles.markAllButton}
              onClick={() => void handleMarkAllVisibleUnplayedAsPlayed()}
              disabled={markAllAsPlayedBusy || visibleUnplayedEpisodeIds.length === 0}
            >
              {markAllAsPlayedBusy ? "Marking..." : "Mark all as played"}
            </button>
          </div>
        }
      >
        {!loading && episodes.length === 0 && !error && (
          <StateMessage variant="empty">No episodes found for this podcast.</StateMessage>
        )}

        <div className={styles.episodeFilterBar}>
          <div className={styles.episodeFilterPills}>
            {([
              ["all", "All"],
              ["unplayed", "Unplayed"],
              ["in_progress", "In Progress"],
              ["played", "Played"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={styles.episodeFilterPill}
                aria-pressed={episodeStateFilter === value}
                onClick={() => setEpisodeStateFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className={styles.episodeSortLabel}>
            Episode sort
            <select
              aria-label="Episode sort"
              value={episodeSort}
              onChange={(event) => setEpisodeSort(event.target.value as EpisodeSort)}
              className={styles.episodeSortSelect}
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="duration_asc">Shortest</option>
              <option value="duration_desc">Longest</option>
            </select>
          </label>
          <label className={styles.episodeSearchLabel}>
            Search episodes
            <input
              type="search"
              aria-label="Search episodes"
              className={styles.episodeSearchInput}
              placeholder="Search titles..."
              value={episodeSearchInput}
              onChange={(event) => setEpisodeSearchInput(event.target.value)}
            />
          </label>
        </div>

        {batchTranscriptSummary && (
          <p className={styles.batchTranscriptSummary}>{batchTranscriptSummary}</p>
        )}

        {episodes.length > 0 && (
          <AppList>
            {episodes.map((episode) => {
              const inLibrary = libraryMediaIds.has(episode.id);
              const busy = busyMediaIds.has(episode.id);
              const episodeState = deriveEpisodeState(episode);
              const episodeProgressPercent = getEpisodeProgressPercent(episode);
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
              const inQueue = queueMediaIds.has(episode.id);
              const showNotesText = episode.description_text?.trim() ?? "";
              const showNotesExpanded = expandedShowNotesMediaIds.has(episode.id);
              const canToggleShowNotes = showNotesText.length > SHOW_NOTES_PREVIEW_MAX_CHARS;
              const rowOptions = [
                {
                  id: "toggle-played",
                  label: episodeState === "played" ? "Mark as unplayed" : "Mark as played",
                  disabled: markingEpisodeIds.has(episode.id),
                  onSelect: () => {
                    void handleMarkEpisodeCompletion(episode, episodeState !== "played");
                  },
                },
                ...(defaultLibraryId
                  ? [
                      {
                        id: inLibrary ? "remove-from-library" : "add-to-library",
                        label: inLibrary ? "Remove from library" : "Add to library",
                        disabled: busy,
                        onSelect: () => {
                          void (inLibrary
                            ? handleRemoveFromLibrary(episode.id)
                            : handleAddToLibrary(episode.id));
                        },
                      },
                    ]
                  : []),
              ];
              return (
                <AppListItem
                  key={episode.id}
                  href={`/media/${episode.id}`}
                  title={
                    <span className={styles.episodeTitle}>
                      {episodeState === "unplayed" && (
                        <span className={styles.unplayedDot} aria-hidden="true" />
                      )}
                      <span
                        className={
                          episodeState === "played" ? styles.playedEpisodeTitleText : undefined
                        }
                      >
                        {episode.title}
                      </span>
                    </span>
                  }
                  description={
                    <span className={styles.episodeDescription}>
                      <span>{episode.capabilities.can_play ? "Playable episode" : "Processing"}</span>
                      {episodeState === "in_progress" && (
                        <span
                          className={styles.inProgressBar}
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={episodeProgressPercent}
                        >
                          <span
                            className={styles.inProgressBarFill}
                            style={{ width: `${episodeProgressPercent}%` }}
                          />
                        </span>
                      )}
                      {showNotesText && (
                        <span className={styles.episodeShowNotes}>
                          <span
                            className={styles.episodeShowNotesPreview}
                            data-expanded={showNotesExpanded ? "true" : "false"}
                          >
                            {showNotesText}
                          </span>
                          {canToggleShowNotes && (
                            <button
                              type="button"
                              className={styles.showNotesToggleButton}
                              aria-label={`${
                                showNotesExpanded ? "Show less" : "Show more"
                              } for ${episode.title}`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                toggleEpisodeShowNotesExpansion(episode.id);
                              }}
                            >
                              {showNotesExpanded ? "Show less" : "Show more"}
                            </button>
                          )}
                        </span>
                      )}
                    </span>
                  }
                  meta={`${episode.processing_status} · ${formatEpisodeTranscriptMeta(episode)} · ${formatEpisodeStateLabel(episodeState)}`}
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
                  options={rowOptions}
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
    </>
  );
}
