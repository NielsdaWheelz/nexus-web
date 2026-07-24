"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { pluralize } from "@/lib/text/pluralize";
import { useResource } from "@/lib/api/useResource";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";
import { podcastResourceOptions } from "@/lib/actions/resourceActions";
import { startResourceContextChat } from "@/lib/resources/resourceContextChat";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneParam,
  usePaneReturnReady,
  usePaneRuntime,
  usePaneRouter,
  usePaneSearchParams,
  usePaneVisitData,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { assumeMediaId, type Placement } from "@/lib/lectern/contract";
import { useStringIdSet } from "@/lib/useStringIdSet";
import PodcastSummaryCard from "./PodcastSummaryCard";
import PodcastEpisodeList from "./PodcastEpisodeList";
import PodcastSubscriptionSettingsModal from "../PodcastSubscriptionSettingsModal";
import LibraryDestinationPicker from "@/components/LibraryDestinationPicker";
import {
  createLibrary,
  type LibraryDestinationSelection,
} from "@/lib/libraries/client";
import PaneSection from "@/components/ui/PaneSection";
import SectionOpener from "@/components/ui/SectionOpener";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import Button from "@/components/ui/Button";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
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

interface PodcastDetailSnapshot {
  readonly detail: PodcastDetailResponse;
  readonly episodes: readonly PodcastEpisodeMedia[];
  readonly hasMoreEpisodes: boolean;
  readonly podcastLibraries: readonly PodcastLibraryMembership[];
}

const PODCAST_DETAIL_VISIT_DATA =
  definePaneVisitDataKey<PodcastDetailSnapshot>("PodcastDetail.Episodes");
const EMPTY_PODCAST_EPISODES: PodcastEpisodeMedia[] = [];
const EMPTY_PODCAST_LIBRARIES: PodcastLibraryMembership[] = [];

export default function PodcastDetailPaneBody() {
  const podcastId = usePaneParam("podcastId");
  const paneRouter = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const paneSearchParams = usePaneSearchParams();
  const { account: billingAccount } = useBillingAccount();
  const player = useGlobalPlayer();
  const lectern = useLectern();
  const committedSnapshotRef = useRef<PodcastDetailSnapshot | null>(null);
  const reconciliationPendingRef = useRef(false);
  const captureCommitted = useCallback(
    () => committedSnapshotRef.current,
    [],
  );
  const restored = usePaneVisitData(
    PODCAST_DETAIL_VISIT_DATA,
    captureCommitted,
  );
  const [controller, setController] =
    useState<PodcastDetailSnapshot | null>(restored);
  const clearAllVisitData = useClearAllPaneVisitData();
  const detail = controller?.detail ?? null;
  const episodes = useMemo(
    () =>
      controller === null
        ? EMPTY_PODCAST_EPISODES
        : [...controller.episodes],
    [controller],
  );
  const hasMoreEpisodes = controller?.hasMoreEpisodes ?? false;
  const podcastLibraries = useMemo(
    () =>
      controller === null
        ? EMPTY_PODCAST_LIBRARIES
        : [...controller.podcastLibraries],
    [controller],
  );
  const setDetail: Dispatch<SetStateAction<PodcastDetailResponse | null>> =
    useCallback((update) => {
      setController((current) => {
        if (current === null) return current;
        const detail =
          typeof update === "function" ? update(current.detail) : update;
        return detail === null ? current : { ...current, detail };
      });
    }, []);
  const setEpisodes: Dispatch<SetStateAction<PodcastEpisodeMedia[]>> =
    useCallback((update) => {
      setController((current) => {
        if (current === null) return current;
        const previous = [...current.episodes];
        const episodes =
          typeof update === "function" ? update(previous) : update;
        return { ...current, episodes };
      });
    }, []);
  const setPodcastLibraries: Dispatch<
    SetStateAction<PodcastLibraryMembership[]>
  > = useCallback((update) => {
    setController((current) => {
      if (current === null) return current;
      const previous = [...current.podcastLibraries];
      const podcastLibraries =
        typeof update === "function" ? update(previous) : update;
      return { ...current, podcastLibraries };
    });
  }, []);
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
  const [loadingMoreEpisodes, setLoadingMoreEpisodes] = useState(false);
  const busyMediaIds = useStringIdSet();
  const markingEpisodeIds = useStringIdSet();
  const [markAllAsPlayedBusy, setMarkAllAsPlayedBusy] = useState(false);
  const expandedShowNotesMediaIds = useStringIdSet();
  const episodeUrlSyncedRef = useRef(false);
  const [loading, setLoading] = useState(restored === null);
  const [suppressInitialLoad, setSuppressInitialLoad] = useState(
    restored !== null,
  );
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [subscribeBusy, setSubscribeBusy] = useState(false);
  const [creatingDestination, setCreatingDestination] = useState(false);
  const [selectedDestinations, setSelectedDestinations] = useState<
    readonly LibraryDestinationSelection[]
  >([]);
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
      clearAllVisitData();
    },
  });
  const transcriptionAllowed = billingAccount?.can_transcribe === true;

  useSetPaneLabel(detail?.podcast.title ?? (loading ? null : "Podcast"));

  const { clear: clearExpandedShowNotesMediaIds } = expandedShowNotesMediaIds;
  const closeSettingsModal = settingsModal.close;
  const podcastDetailCacheKey = podcastId && !suppressInitialLoad
    ? [
        "podcast-detail",
        podcastId,
        episodeStateFilter,
        episodeSort,
        episodeSearchQuery.trim(),
        reloadNonce,
      ].join(":")
    : null;
  const reload = useCallback(() => {
    reconciliationPendingRef.current = true;
    committedSnapshotRef.current = null;
    clearAllVisitData();
    setSuppressInitialLoad(false);
    setReloadNonce((nonce) => nonce + 1);
  }, [clearAllVisitData]);

  const transcript = useEpisodeTranscriptController({
    episodes,
    setEpisodes,
    transcriptionAllowed,
    setError,
    reload,
    onMutationCommitted: clearAllVisitData,
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
      reconciliationPendingRef.current = false;
      setController({
        detail: result.detail,
        episodes: result.episodes,
        hasMoreEpisodes: result.episodes.length === EPISODES_PAGE_SIZE,
        podcastLibraries: result.podcastLibraries,
      });
      clearExpandedShowNotesMediaIds();
      resetForecasts();
      closeSettingsModal();
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

  useLayoutEffect(() => {
    committedSnapshotRef.current = reconciliationPendingRef.current
      ? null
      : controller;
  }, [controller]);

  usePaneReturnReady(
    (!loading && controller !== null) || error !== null,
  );

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
    const nextHref = `/podcasts/${podcastId}?${params.toString()}`;
    const transitionOptions = episodeUrlSyncedRef.current
      ? { viewTransition: { kind: "collection-reflow" as const } }
      : undefined;
    episodeUrlSyncedRef.current = true;
    paneRouter.replace(nextHref, transitionOptions);
  }, [
    episodeSearchQuery,
    episodeSort,
    episodeStateFilter,
    paneRouter,
    podcastId,
  ]);

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
      setController((current) =>
        current === null
          ? current
          : {
              ...current,
              episodes: [...current.episodes, ...response.data],
              hasMoreEpisodes:
                response.data.length === EPISODES_PAGE_SIZE,
            },
      );
    } catch (loadError) {
      if (handleUnauthenticatedApiError(loadError)) return;
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
        library_ids: selectedDestinations.map((destination) => destination.id),
      });
      setSelectedDestinations([]);
      reload();
    } catch (subscribeError) {
      if (handleUnauthenticatedApiError(subscribeError)) return;
      setError(
        toFeedback(subscribeError, {
          fallback: "Failed to subscribe to podcast",
        }),
      );
    } finally {
      setSubscribeBusy(false);
    }
  }, [detail, reload, selectedDestinations]);

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
  }, [actions, detail?.subscription, podcastId, reload, setDetail]);

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
      clearAllVisitData();
    });
  }, [
    actions,
    clearAllVisitData,
    detail,
    podcastId,
    setDetail,
    setPodcastLibraries,
  ]);

  const openSettingsModal = useCallback(() => {
    if (!detail?.subscription) {
      return;
    }
    settingsModal.open(detail.subscription);
  }, [detail, settingsModal]);

  const handleOpenEpisodeChat = useCallback(
    async (episode: PodcastEpisodeMedia) => {
      try {
        const conversationId = await startResourceContextChat(`media:${episode.id}`);
        clearAllVisitData();
        openInNewPane?.(`/conversations/${conversationId}`, episode.title);
      } catch (chatError) {
        if (handleUnauthenticatedApiError(chatError)) return;
        setError(
          toFeedback(chatError, { fallback: "Failed to open episode chat" }),
        );
      }
    },
    [clearAllVisitData, openInNewPane],
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
        clearAllVisitData();
      } catch (retryError) {
        if (handleUnauthenticatedApiError(retryError)) return;
        setError(
          toFeedback(retryError, {
            fallback: "Failed to retry episode processing",
          }),
        );
      } finally {
        busyMediaIds.remove(mediaId);
      }
    },
    [busyMediaIds, clearAllVisitData, setEpisodes],
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
        clearAllVisitData();
      } catch (refreshError) {
        if (handleUnauthenticatedApiError(refreshError)) return;
        setError(
          toFeedback(refreshError, {
            fallback: "Failed to refresh episode source",
          }),
        );
      } finally {
        busyMediaIds.remove(mediaId);
      }
    },
    [busyMediaIds, clearAllVisitData, setEpisodes],
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
        clearAllVisitData();
      } catch (deleteError) {
        if (handleUnauthenticatedApiError(deleteError)) return;
        setError(
          toFeedback(deleteError, { fallback: "Failed to delete episode" }),
        );
      } finally {
        busyMediaIds.remove(episode.id);
      }
    },
    [busyMediaIds, clearAllVisitData, setEpisodes],
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
        // The heartbeat engine owns the listening-state route now; played/unplayed
        // toggles flow through the Lectern consumption FIFO (spec §5.2).
        if (isCompleted) {
          await lectern.ensureMediaFinished(assumeMediaId(mediaId));
        } else {
          await lectern.setUnread(assumeMediaId(mediaId));
        }
        clearAllVisitData();
      } catch (markError) {
        setEpisodes(previousEpisodes);
        if (handleUnauthenticatedApiError(markError)) return;
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
    [
      applyEpisodeCompletionState,
      clearAllVisitData,
      episodeStateFilter,
      episodes,
      lectern,
      markingEpisodeIds,
      setEpisodes,
    ],
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
      await lectern.setBatchState({
        mediaIds: visibleUnplayedEpisodeIds.map(assumeMediaId),
        state: "Finished",
      });
      clearAllVisitData();
    } catch (markError) {
      setEpisodes(previousEpisodes);
      if (handleUnauthenticatedApiError(markError)) return;
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
    clearAllVisitData,
    episodeStateFilter,
    episodes,
    lectern,
    setEpisodes,
    visibleUnplayedEpisodeIds,
  ]);

  // Which episodes are already On Lectern, from the canonical Lectern snapshot
  // (replaces the deleted player queue). Empty until the snapshot is Ready.
  const lecternMediaIds = useMemo<Set<string>>(() => {
    const snapshot = lectern.resource;
    if (snapshot.status !== "ready") {
      return new Set<string>();
    }
    return new Set<string>(snapshot.data.items.map((item) => item.mediaId));
  }, [lectern.resource]);

  // "Play next" is disabled/no-op for the media that is the active Lectern
  // origin's descriptor (spec §5.1 "targeting the current origin is disabled").
  const playNextDisabledMediaId = useMemo<string | null>(() => {
    const state = player.state;
    if (state.kind === "Absent") {
      return null;
    }
    const { session } = state;
    return session.origin.kind === "Lectern"
      ? session.descriptor.mediaId
      : null;
  }, [player.state]);

  // Play next: place After the exact Lectern origin item, else at the head
  // (spec §5.1). Add to Lectern: append Last.
  const handlePlayNext = useCallback(
    (mediaId: string) => {
      const state = player.state;
      const session = state.kind === "Absent" ? undefined : state.session;
      const placement: Placement =
        session && session.origin.kind === "Lectern"
          ? { kind: "After", itemId: session.origin.itemId }
          : { kind: "First" };
      void lectern
        .placeItems({
          mediaIds: [assumeMediaId(mediaId)],
          placement,
        })
        .then(clearAllVisitData);
    },
    [clearAllVisitData, lectern, player.state],
  );

  const handleAddToLectern = useCallback(
    (mediaId: string) => {
      void lectern
        .placeItems({
          mediaIds: [assumeMediaId(mediaId)],
          placement: { kind: "Last" },
        })
        .then(clearAllVisitData);
    },
    [clearAllVisitData, lectern],
  );
  const activeSubscription = detail?.subscription ?? null;
  const paneOptions = podcastResourceOptions({
    canUsePodcastActions: Boolean(activeSubscription),
    refreshBusy: refreshSyncBusy,
    unsubscribeBusy,
    onOpenSettings: () => openSettingsModal(),
    onRefreshSync: refreshPodcastSync,
    onUnsubscribe: unsubscribePodcast,
  });

  const openConnectionRoute = useCallback(
    (
      href: string,
      inNewPane: boolean,
      secondaryActivation?: WorkspaceSecondaryActivation,
    ) => {
      if (inNewPane) openInNewPane?.(href, undefined, secondaryActivation);
      else paneRouter.push(href);
    },
    [openInNewPane, paneRouter],
  );
  const connectionsComposerController = useConnectionsComposerController({
    scheme: "podcast",
    id: podcastId ?? "",
  });
  const connectionsBody = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "podcast", id: podcastId ?? "" }}
        composerController={connectionsComposerController}
        onOpenRoute={openConnectionRoute}
      />
    ),
    [connectionsComposerController, openConnectionRoute, podcastId],
  );
  const { companionAction } = useResourceInspector({
    scheme: "podcast",
    handle: podcastId,
    bodies: { linkedItems: connectionsBody },
  });
  usePanePrimaryChrome({
    actions: companionAction ? [companionAction] : [],
    options: paneOptions,
    header: {
      kind: "section",
      folio: { kind: "count", value: episodes.length, unit: "episode" },
      pending: loading,
    },
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
      busyMediaIds={busyMediaIds}
      markingEpisodeIds={markingEpisodeIds}
      expandedShowNotesMediaIds={expandedShowNotesMediaIds}
      lecternMediaIds={lecternMediaIds}
      playNextDisabledMediaId={playNextDisabledMediaId}
      lecternReady={lectern.resource.status === "ready"}
      visibleUnplayedEpisodeIds={visibleUnplayedEpisodeIds}
      markAllAsPlayedBusy={markAllAsPlayedBusy}
      hasMoreEpisodes={hasMoreEpisodes}
      loadingMoreEpisodes={loadingMoreEpisodes}
      onMarkAllVisibleUnplayedAsPlayed={() =>
        void handleMarkAllVisibleUnplayedAsPlayed()
      }
      onLoadMoreEpisodes={() => void handleLoadMoreEpisodes()}
      onToggleShowNotes={toggleEpisodeShowNotesExpansion}
      onPlayNext={handlePlayNext}
      onAddToLectern={handleAddToLectern}
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
      <div className={styles.primaryScroll}>
        <SectionOpener
          heading={detail?.podcast.title ?? "Podcast"}
          scale="title"
          pending={loading}
        />
        <div className={styles.headerActions}>
          <Link href="/podcasts" className={styles.navLink}>
            Podcasts
          </Link>
          <div className={styles.headerButtons}>
            {activeSubscription ? null : (
              <div className={styles.subscriptionActions}>
                <LibraryDestinationPicker
                  selected={selectedDestinations}
                  onChange={setSelectedDestinations}
                  presentation={{ kind: "Inline" }}
                  label="Libraries"
                  interaction={
                    creatingDestination
                      ? { kind: "Creating" }
                      : subscribeBusy
                        ? { kind: "Disabled" }
                        : { kind: "Enabled" }
                  }
                  onCreateDestination={async (name) => {
                    setCreatingDestination(true);
                    try {
                      const library = await createLibrary({ name });
                      clearAllVisitData();
                      return library;
                    } finally {
                      setCreatingDestination(false);
                    }
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleSubscribe()}
                  disabled={subscribeBusy || creatingDestination || !detail}
                >
                  {subscribeBusy ? "Subscribing..." : "Subscribe"}
                </Button>
              </div>
            )}
          </div>
        </div>
        <PaneSection>
          {loading && <PaneLoadingState />}
          {error && <FeedbackNotice feedback={error} />}
          {!loading && detail && (
            <PodcastSummaryCard
              detail={detail}
              activeSubscription={activeSubscription}
              podcastLibraryCount={podcastLibraryCount}
            />
          )}
        </PaneSection>
        <PaneSection>{episodePaneContent}</PaneSection>
      </div>

      <PodcastSubscriptionSettingsModal
        podcastTitle={
          settingsModal.podcastId !== null && detail && activeSubscription
            ? detail.podcast.title
            : null
        }
        settingsModal={settingsModal}
      />
    </>
  );
}
