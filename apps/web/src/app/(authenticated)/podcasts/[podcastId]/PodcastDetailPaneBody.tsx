"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/client";
import { pluralize } from "@/lib/text/pluralize";
import { useResource } from "@/lib/api/useResource";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";
import { podcastResourceOptions } from "@/lib/actions/resourceActions";
import {
  usePaneParam,
  usePaneRuntime,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { patchLibraryMembership } from "@/lib/media/mediaLibraries";
import { useStringIdSet } from "@/lib/useStringIdSet";
import PodcastSummaryCard from "./PodcastSummaryCard";
import PodcastEpisodeList from "./PodcastEpisodeList";
import PodcastSubscriptionSettingsModal from "../PodcastSubscriptionSettingsModal";
import LibraryDestinationPicker from "@/components/LibraryDestinationPicker";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import SectionCard from "@/components/ui/SectionCard";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import Button from "@/components/ui/Button";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import {
  fetchPodcastLibraries,
  getPodcastSubscriptionSettingsPatch,
  subscribeToPodcast,
  type PodcastDetailResponse,
  type PodcastLibraryMembership,
} from "../podcastSubscriptions";
import { usePodcastSubscriptionActions } from "../usePodcastSubscriptionActions";
import { useEpisodeTranscriptController } from "./useEpisodeTranscriptController";
import { usePodcastSubscriptionSettingsModal } from "../usePodcastSubscriptionSettingsModal";
import {
  deriveEpisodeState,
  episodeMatchesFilter,
  type EpisodeSort,
  type EpisodeStateFilter,
  type PodcastEpisodeMedia,
} from "./episodeTranscript";
import styles from "./page.module.css";

const EPISODES_PAGE_SIZE = 100;
const EPISODE_SEARCH_DEBOUNCE_MS = 300;

interface PodcastDetailLoadResult {
  detail: PodcastDetailResponse;
  episodes: PodcastEpisodeMedia[];
  podcastLibraries: PodcastLibraryMembership[];
}

export default function PodcastDetailPaneBody() {
  const podcastId = usePaneParam("podcastId");
  const paneRouter = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const paneSearchParams = usePaneSearchParams();
  const isMobileViewport = useIsMobileViewport();
  const { account: billingAccount } = useBillingAccount();
  const { addToQueue, queueItems } = useGlobalPlayer();
  const [detail, setDetail] = useState<PodcastDetailResponse | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisodeMedia[]>([]);
  const [episodeStateFilter, setEpisodeStateFilter] =
    useState<EpisodeStateFilter>(() => {
      const stateParam = paneSearchParams.get("state");
      if (
        stateParam === "unplayed" ||
        stateParam === "in_progress" ||
        stateParam === "played"
      ) {
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
  const [episodeSearchInput, setEpisodeSearchInput] = useState(
    () => paneSearchParams.get("q") ?? "",
  );
  const [episodeSearchQuery, setEpisodeSearchQuery] = useState(
    () => paneSearchParams.get("q") ?? "",
  );
  const [hasMoreEpisodes, setHasMoreEpisodes] = useState(false);
  const [loadingMoreEpisodes, setLoadingMoreEpisodes] = useState(false);
  const [podcastLibraries, setPodcastLibraries] = useState<
    PodcastLibraryMembership[]
  >([]);
  const [podcastLibrariesLoading, setPodcastLibrariesLoading] = useState(false);
  const busyMediaIds = useStringIdSet();
  const [podcastMembershipPanelOpen, setPodcastMembershipPanelOpen] =
    useState(false);
  const [podcastMembershipPanelTriggerEl, setPodcastMembershipPanelTriggerEl] =
    useState<HTMLElement | null>(null);
  const markingEpisodeIds = useStringIdSet();
  const [markAllAsPlayedBusy, setMarkAllAsPlayedBusy] = useState(false);
  const expandedShowNotesMediaIds = useStringIdSet();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [subscribeBusy, setSubscribeBusy] = useState(false);
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const actions = usePodcastSubscriptionActions(setError);
  const refreshSyncBusy = podcastId
    ? actions.refreshingPodcastIds.ids.has(podcastId)
    : false;
  const unsubscribeBusy = podcastId
    ? actions.unsubscribingPodcastIds.ids.has(podcastId)
    : false;
  const settingsModal = usePodcastSubscriptionSettingsModal({
    onSaved: (response) => {
      setDetail((prev) =>
        prev && prev.subscription
          ? {
              ...prev,
              subscription: {
                ...prev.subscription,
                ...getPodcastSubscriptionSettingsPatch({
                  response,
                  updatedAt: prev.subscription.updated_at,
                }),
              },
            }
          : prev,
      );
      setEpisodes((prev) =>
        prev.map((episode) => ({
          ...episode,
          subscription_default_playback_speed: response.default_playback_speed,
        })),
      );
    },
  });
  const [episodesDrawerOpen, setEpisodesDrawerOpen] = useState(false);
  const billingDisabled = billingAccount?.billing_enabled === false;
  const transcriptionAllowed = billingAccount?.can_transcribe === true;

  useSetPaneTitle(detail?.podcast.title ?? (loading ? null : "Podcast"));

  // Populate the membership panel's library list for the active podcast. The
  // hook's loadLibraries does the fetch + error reporting; this layer adds the
  // loading flag and the "already loaded" short-circuit.
  const ensurePodcastLibrariesLoaded = useCallback(async () => {
    if (!podcastId || podcastLibrariesLoading || podcastLibraries.length > 0) {
      return;
    }
    setPodcastLibrariesLoading(true);
    try {
      const nextLibraries = await actions.loadLibraries(podcastId);
      setPodcastLibraries(nextLibraries ?? []);
    } finally {
      setPodcastLibrariesLoading(false);
    }
  }, [actions, podcastId, podcastLibraries.length, podcastLibrariesLoading]);

  const { clear: clearExpandedShowNotesMediaIds } = expandedShowNotesMediaIds;
  const closeSettingsModal = settingsModal.close;
  const podcastDetailCacheKey = podcastId
    ? [
        "podcast-detail",
        podcastId,
        episodeStateFilter,
        episodeSort,
        episodeSearchQuery.trim(),
        reloadNonce,
      ].join(":")
    : null;
  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  const transcript = useEpisodeTranscriptController({
    episodes,
    setEpisodes,
    transcriptionAllowed,
    setError,
    reload,
  });
  const { resetForecasts } = transcript;

  const fetchPodcastDetail = useCallback(
    async (signal?: AbortSignal): Promise<PodcastDetailLoadResult> => {
      if (!podcastId) {
        throw new Error("Podcast id is missing");
      }
      const episodeParams = new URLSearchParams({
        limit: String(EPISODES_PAGE_SIZE),
        offset: "0",
        state: episodeStateFilter,
        sort: episodeSort,
      });
      if (episodeSearchQuery.trim()) {
        episodeParams.set("q", episodeSearchQuery.trim());
      }

      const fetchOptions = signal ? { signal } : undefined;
      const [detailResp, episodesResp] = await Promise.all([
        apiFetch<{ data: PodcastDetailResponse }>(
          `/api/podcasts/${podcastId}`,
          fetchOptions,
        ),
        apiFetch<{ data: PodcastEpisodeMedia[] }>(
          `/api/podcasts/${podcastId}/episodes?${episodeParams}`,
          fetchOptions,
        ),
      ]);
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      let podcastLibraries: PodcastLibraryMembership[] = [];
      if (detailResp.data.subscription) {
        try {
          podcastLibraries = await fetchPodcastLibraries(podcastId);
        } catch {
          podcastLibraries = [];
        }
      }
      return {
        detail: detailResp.data,
        episodes: episodesResp.data,
        podcastLibraries,
      };
    },
    [episodeSearchQuery, episodeSort, episodeStateFilter, podcastId],
  );

  const applyPodcastDetailLoad = useCallback(
    (result: PodcastDetailLoadResult) => {
      setDetail(result.detail);
      setEpisodes(result.episodes);
      clearExpandedShowNotesMediaIds();
      setHasMoreEpisodes(result.episodes.length === EPISODES_PAGE_SIZE);
      resetForecasts();
      closeSettingsModal();
      setPodcastLibraries(result.podcastLibraries);
    },
    [clearExpandedShowNotesMediaIds, closeSettingsModal, resetForecasts],
  );

  const podcastDetailResource = useResource<PodcastDetailLoadResult>({
    cacheKey: podcastDetailCacheKey,
    load: fetchPodcastDetail,
  });

  useEffect(() => {
    if (!podcastId) {
      setLoading(false);
      setError({ severity: "error", title: "Podcast id is missing" });
      return;
    }

    if (podcastDetailResource.status === "loading") {
      setLoading(true);
      setError(null);
      return;
    }

    if (podcastDetailResource.status === "ready") {
      applyPodcastDetailLoad(podcastDetailResource.data);
      setError(null);
      setLoading(false);
      return;
    }

    if (podcastDetailResource.status === "error") {
      setError(
        toFeedback(podcastDetailResource.error, {
          fallback: "Failed to load podcast detail",
        }),
      );
      setLoading(false);
    }
  }, [applyPodcastDetailLoad, podcastDetailResource, podcastId]);

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
  }, [
    episodeSearchQuery,
    episodeSort,
    episodeStateFilter,
    paneRouter,
    podcastId,
  ]);

  const episodesDrawerRef = useRef<HTMLElement>(null);
  useDialogOverlay({
    ref: episodesDrawerRef,
    active: isMobileViewport && episodesDrawerOpen,
    onDismiss: () => setEpisodesDrawerOpen(false),
  });

  useEffect(() => {
    if (episodesDrawerOpen && !isMobileViewport) {
      setEpisodesDrawerOpen(false);
    }
  }, [episodesDrawerOpen, isMobileViewport]);

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
        `/api/podcasts/${podcastId}/episodes?${episodeParams}`,
      );
      setEpisodes((prev) => [...prev, ...response.data]);
      setHasMoreEpisodes(response.data.length === EPISODES_PAGE_SIZE);
    } catch (loadError) {
      setError(
        toFeedback(loadError, {
          fallback: "Failed to load more podcast episodes",
        }),
      );
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

  const handleSubscribe = useCallback(async () => {
    if (!detail) {
      return;
    }
    setSubscribeBusy(true);
    setError(null);
    try {
      await subscribeToPodcast({
        provider_podcast_id: detail.podcast.provider_podcast_id,
        title: detail.podcast.title,
        contributors: detail.podcast.contributors,
        feed_url: detail.podcast.feed_url,
        website_url: detail.podcast.website_url,
        image_url: detail.podcast.image_url,
        description: detail.podcast.description,
        library_ids: selectedLibraryIds,
      });
      setSelectedLibraryIds([]);
      reload();
    } catch (subscribeError) {
      setError(
        toFeedback(subscribeError, {
          fallback: "Failed to subscribe to podcast",
        }),
      );
    } finally {
      setSubscribeBusy(false);
    }
  }, [detail, reload, selectedLibraryIds]);

  const addPodcastToLibrary = useCallback(
    (libraryId: string) => {
      if (!podcastId) {
        return;
      }
      void actions.addToLibrary(podcastId, libraryId, () => {
        setPodcastLibraries((prev) =>
          patchLibraryMembership(prev, libraryId, true),
        );
      });
    },
    [actions, podcastId],
  );

  const removePodcastFromLibrary = useCallback(
    (libraryId: string) => {
      if (!podcastId) {
        return;
      }
      void actions.removeFromLibrary(podcastId, libraryId, () => {
        setPodcastLibraries((prev) =>
          patchLibraryMembership(prev, libraryId, false),
        );
      });
    },
    [actions, podcastId],
  );

  const refreshPodcastSync = useCallback(() => {
    if (!podcastId || !detail?.subscription) {
      return;
    }
    void actions.refreshSync(podcastId, (patch) => {
      setDetail((prev) =>
        prev && prev.subscription
          ? { ...prev, subscription: { ...prev.subscription, ...patch } }
          : prev,
      );
      reload();
    });
  }, [actions, detail?.subscription, podcastId, reload]);

  const unsubscribePodcast = useCallback(() => {
    if (!podcastId || !detail?.subscription) {
      return;
    }
    void actions.unsubscribe(podcastId, detail.podcast.title, (libraries) => {
      const retainedLibraries = libraries.filter(
        (library) => library.isInLibrary && !library.canRemove,
      );
      setDetail((prev) => (prev ? { ...prev, subscription: null } : prev));
      setPodcastLibraries(retainedLibraries);
      setPodcastMembershipPanelOpen(false);
      setPodcastMembershipPanelTriggerEl(null);
    });
  }, [actions, detail, podcastId]);

  const openSettingsModal = useCallback(() => {
    if (!detail?.subscription) {
      return;
    }
    settingsModal.open(detail.subscription);
  }, [detail, settingsModal]);

  const handleOpenEpisodeChat = useCallback(
    async (episode: PodcastEpisodeMedia) => {
      try {
        const response = await apiFetch<{
          data: { id: string };
        }>("/api/conversations", {
          method: "POST",
          body: JSON.stringify({ initial_references: [`media:${episode.id}`] }),
        });
        const route = `/conversations/${response.data.id}`;
        openInNewPane?.(route, episode.title);
      } catch (chatError) {
        setError(
          toFeedback(chatError, { fallback: "Failed to open episode chat" }),
        );
      }
    },
    [openInNewPane],
  );

  const handleRetryEpisodeProcessing = useCallback(
    async (mediaId: string) => {
      busyMediaIds.add(mediaId);
      setError(null);
      try {
        const projection = await runSourceProcessingAction({
          mediaId,
          action: "retry",
          successTitle: "Processing retry started.",
        });
        setEpisodes((prev) =>
          prev.map((episode) =>
            episode.id === mediaId
              ? {
                  ...episode,
                  processing_status: projection.processingStatus,
                  transcript_state: projection.sourceFailed
                    ? episode.transcript_state
                    : "queued",
                  transcript_coverage: projection.sourceFailed
                    ? episode.transcript_coverage
                    : "none",
                  capabilities: {
                    ...episode.capabilities,
                    ...projection.capabilityPatch,
                  },
                }
              : episode,
          ),
        );
        setError(projection.feedback);
      } catch (retryError) {
        setError(
          toFeedback(retryError, {
            fallback: "Failed to retry episode processing",
          }),
        );
      } finally {
        busyMediaIds.remove(mediaId);
      }
    },
    [busyMediaIds],
  );

  const handleRefreshEpisodeSource = useCallback(
    async (mediaId: string) => {
      busyMediaIds.add(mediaId);
      setError(null);
      try {
        const projection = await runSourceProcessingAction({
          mediaId,
          action: "refresh",
          successTitle: "Source refresh started.",
        });
        setEpisodes((prev) =>
          prev.map((episode) =>
            episode.id === mediaId
              ? {
                  ...episode,
                  processing_status: projection.processingStatus,
                  transcript_state: projection.sourceFailed
                    ? episode.transcript_state
                    : "queued",
                  transcript_coverage: projection.sourceFailed
                    ? episode.transcript_coverage
                    : "none",
                  capabilities: {
                    ...episode.capabilities,
                    ...projection.capabilityPatch,
                  },
                }
              : episode,
          ),
        );
        setError(projection.feedback);
      } catch (refreshError) {
        setError(
          toFeedback(refreshError, {
            fallback: "Failed to refresh episode source",
          }),
        );
      } finally {
        busyMediaIds.remove(mediaId);
      }
    },
    [busyMediaIds],
  );

  const handleDeleteEpisode = useCallback(
    async (episode: PodcastEpisodeMedia) => {
      if (
        !confirm(
          `Delete "${episode.title}" from My Library and libraries you manage? This cannot be undone.`,
        )
      ) {
        return;
      }

      busyMediaIds.add(episode.id);
      setError(null);
      try {
        await apiFetch(`/api/media/${episode.id}`, { method: "DELETE" });
        setEpisodes((prev) =>
          prev.filter((candidate) => candidate.id !== episode.id),
        );
      } catch (deleteError) {
        setError(
          toFeedback(deleteError, { fallback: "Failed to delete episode" }),
        );
      } finally {
        busyMediaIds.remove(episode.id);
      }
    },
    [busyMediaIds],
  );

  const applyEpisodeCompletionState = useCallback(
    (
      episode: PodcastEpisodeMedia,
      isCompleted: boolean,
    ): PodcastEpisodeMedia => {
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
    [],
  );

  const handleMarkEpisodeCompletion = useCallback(
    async (episode: PodcastEpisodeMedia, isCompleted: boolean) => {
      const mediaId = episode.id;
      markingEpisodeIds.add(mediaId);
      setError(null);
      const previousEpisodes = episodes;
      setEpisodes((prev) =>
        prev.flatMap((candidate) => {
          if (candidate.id !== mediaId) {
            return [candidate];
          }
          const optimisticEpisode = applyEpisodeCompletionState(
            candidate,
            isCompleted,
          );
          if (
            !episodeMatchesFilter(
              deriveEpisodeState(optimisticEpisode),
              episodeStateFilter,
            )
          ) {
            return [];
          }
          return [optimisticEpisode];
        }),
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
                },
          ),
        });
      } catch (markError) {
        setEpisodes(previousEpisodes);
        setError(
          toFeedback(markError, {
            fallback: isCompleted
              ? "Failed to mark episode as played"
              : "Failed to mark episode as unplayed",
          }),
        );
      } finally {
        markingEpisodeIds.remove(mediaId);
      }
    },
    [applyEpisodeCompletionState, episodeStateFilter, episodes, markingEpisodeIds],
  );

  const visibleUnplayedEpisodeIds = useMemo(
    () =>
      episodes
        .filter((episode) => deriveEpisodeState(episode) === "unplayed")
        .map((episode) => episode.id),
    [episodes],
  );

  const toggleEpisodeShowNotesExpansion = useCallback(
    (mediaId: string) => {
      if (expandedShowNotesMediaIds.has(mediaId)) {
        expandedShowNotesMediaIds.remove(mediaId);
      } else {
        expandedShowNotesMediaIds.add(mediaId);
      }
    },
    [expandedShowNotesMediaIds],
  );

  const handleMarkAllVisibleUnplayedAsPlayed = useCallback(async () => {
    if (visibleUnplayedEpisodeIds.length === 0) {
      return;
    }
    if (
      !window.confirm(
        `Mark ${pluralize(visibleUnplayedEpisodeIds.length, "visible episode")} as played?`,
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
        if (
          !episodeMatchesFilter(
            deriveEpisodeState(optimisticEpisode),
            episodeStateFilter,
          )
        ) {
          return [];
        }
        return [optimisticEpisode];
      }),
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
      setError(
        toFeedback(markError, {
          fallback: "Failed to mark visible episodes as played",
        }),
      );
    } finally {
      setMarkAllAsPlayedBusy(false);
    }
  }, [
    applyEpisodeCompletionState,
    episodeStateFilter,
    episodes,
    visibleUnplayedEpisodeIds,
  ]);

  const queueMediaIds = useMemo(() => {
    return new Set(queueItems.map((item) => item.media_id));
  }, [queueItems]);
  const activeSubscription = detail?.subscription ?? null;
  const podcastMembershipBusy = actions.busyLibraryMembershipKeys.ids.size > 0;
  const paneOptions = podcastResourceOptions({
    canUsePodcastActions: Boolean(activeSubscription),
    refreshBusy: refreshSyncBusy,
    unsubscribeBusy,
    onManageLibraries: ({ triggerEl }) => {
      setPodcastMembershipPanelOpen(true);
      setPodcastMembershipPanelTriggerEl(triggerEl);
      void ensurePodcastLibrariesLoaded();
    },
    onOpenSettings: () => openSettingsModal(),
    onRefreshSync: refreshPodcastSync,
    onUnsubscribe: unsubscribePodcast,
  });

  usePaneChromeOverride({
    actions: isMobileViewport ? (
      <Button
        variant="secondary"
        size="sm"
        className={styles.paneActionButton}
        onClick={() => setEpisodesDrawerOpen((open) => !open)}
        aria-label="Episodes"
        aria-expanded={episodesDrawerOpen}
      >
        Episodes
      </Button>
    ) : undefined,
    options: paneOptions,
  });

  const podcastLibraryCount = podcastLibraries.filter(
    (library) => library.isInLibrary,
  ).length;
  const episodePaneContent = (
    <PodcastEpisodeList
      episodes={episodes}
      loading={loading}
      error={error}
      episodeStateFilter={episodeStateFilter}
      setEpisodeStateFilter={setEpisodeStateFilter}
      episodeSort={episodeSort}
      setEpisodeSort={setEpisodeSort}
      episodeSearchInput={episodeSearchInput}
      setEpisodeSearchInput={setEpisodeSearchInput}
      transcript={transcript}
      transcriptionAllowed={transcriptionAllowed}
      billingDisabled={billingDisabled}
      busyMediaIds={busyMediaIds}
      markingEpisodeIds={markingEpisodeIds}
      expandedShowNotesMediaIds={expandedShowNotesMediaIds}
      queueMediaIds={queueMediaIds}
      visibleUnplayedEpisodeIds={visibleUnplayedEpisodeIds}
      markAllAsPlayedBusy={markAllAsPlayedBusy}
      hasMoreEpisodes={hasMoreEpisodes}
      loadingMoreEpisodes={loadingMoreEpisodes}
      onMarkAllVisibleUnplayedAsPlayed={() =>
        void handleMarkAllVisibleUnplayedAsPlayed()
      }
      onLoadMoreEpisodes={() => void handleLoadMoreEpisodes()}
      onToggleShowNotes={toggleEpisodeShowNotesExpansion}
      onAddToQueue={(mediaId, position) => {
        void addToQueue(mediaId, position);
      }}
      onOpenChat={(episode) => {
        void handleOpenEpisodeChat(episode);
      }}
      onRetry={(mediaId) => {
        void handleRetryEpisodeProcessing(mediaId);
      }}
      onRefreshSource={(mediaId) => {
        void handleRefreshEpisodeSource(mediaId);
      }}
      onDelete={(episode) => {
        void handleDeleteEpisode(episode);
      }}
      onTogglePlayed={(episode, isCompleted) => {
        void handleMarkEpisodeCompletion(episode, isCompleted);
      }}
    />
  );

  if (!podcastId) {
    return (
      <>
        <FeedbackNotice severity="error" title="Podcast id is missing." />
      </>
    );
  }

  return (
    <>
      <div className={styles.splitLayout}>
        <div className={styles.primaryColumn}>
          <div className={styles.primaryScroll}>
            <div className={styles.headerActions}>
              <Link href="/podcasts" className={styles.navLink}>
                Podcasts
              </Link>
              <div className={styles.headerButtons}>
                {activeSubscription ? null : (
                  <div className={styles.subscriptionActions}>
                    <LibraryDestinationPicker
                      selectedLibraryIds={selectedLibraryIds}
                      onChange={setSelectedLibraryIds}
                      label="Libraries"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleSubscribe()}
                      disabled={subscribeBusy || !detail}
                    >
                      {subscribeBusy ? "Subscribing..." : "Subscribe"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
            <SectionCard>
              {loading && <PaneLoadingState />}
              {error && <FeedbackNotice feedback={error} />}
              {!loading && detail && (
                <PodcastSummaryCard
                  detail={detail}
                  activeSubscription={activeSubscription}
                  podcastLibraryCount={podcastLibraryCount}
                />
              )}
            </SectionCard>
          </div>
        </div>

        {!isMobileViewport ? (
          <aside className={styles.episodesColumn} aria-label="Episodes">
            <div className={styles.episodesColumnHeader}>
              <h2>Episodes</h2>
            </div>
            <div className={styles.episodesColumnBody}>
              {episodePaneContent}
            </div>
          </aside>
        ) : null}
      </div>

      <LibraryMembershipPanel
        open={podcastMembershipPanelOpen}
        title="Libraries"
        anchorEl={podcastMembershipPanelTriggerEl}
        libraries={podcastLibraries}
        loading={podcastLibrariesLoading}
        busy={podcastMembershipBusy}
        error={error}
        emptyMessage="No non-default libraries available."
        onClose={() => {
          setPodcastMembershipPanelOpen(false);
          setPodcastMembershipPanelTriggerEl(null);
        }}
        onAddToLibrary={addPodcastToLibrary}
        onRemoveFromLibrary={removePodcastFromLibrary}
      />

      <PodcastSubscriptionSettingsModal
        podcastTitle={
          settingsModal.podcastId !== null && detail && activeSubscription
            ? detail.podcast.title
            : null
        }
        settingsModal={settingsModal}
      />

      {isMobileViewport && episodesDrawerOpen ? (
        <div
          className={styles.episodesBackdrop}
          data-testid="episodes-backdrop"
          onClick={() => setEpisodesDrawerOpen(false)}
        >
          <aside
            ref={episodesDrawerRef}
            className={styles.episodesDrawer}
            role="dialog"
            aria-modal="true"
            aria-label="Episodes"
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.episodesDrawerHeader}>
              <h2>Episodes</h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEpisodesDrawerOpen(false)}
              >
                Close
              </Button>
            </header>
            <div className={styles.episodesDrawerBody}>
              {episodePaneContent}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
