"use client";

import {
  lazy,
  Suspense,
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
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import {
  decodeCollectionPage,
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useResource } from "@/lib/api/useResource";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";
import { retryMediaMetadata } from "@/lib/media/ingestionClient";
import { confirmAndDeleteMedia } from "@/lib/media/mediaLibraries";
import { mapMediaAuthorCredits } from "@/app/(authenticated)/media/[id]/mediaFormatting";
import {
  RESOURCE_ACTION_CATALOG,
  podcastResourceOptions,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneParam,
  usePaneReturnReady,
  usePaneRuntime,
  requirePaneRuntime,
  usePaneRouter,
  usePaneSearchParams,
  usePaneVisitData,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import {
  canonicalSessionOfGlobalState,
  useGlobalPlayer,
} from "@/lib/player/globalPlayer";
import { formatSubscriptionPlaybackSummary } from "@/lib/player/subscriptionPlaybackSpeed";
import { pluralize } from "@/lib/text/pluralize";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { useCompletionUndo } from "@/lib/lectern/useCompletionUndo";
import { runProgressReset } from "@/lib/consumption/progressReset";
import {
  assumeMediaId,
  type LecternItemId,
  type Placement,
} from "@/lib/lectern/contract";
import { useStringIdSet } from "@/lib/useStringIdSet";
import PodcastOverview from "@/components/podcasts/PodcastOverview";
import AcquisitionControl from "@/components/browse/AcquisitionControl";
import PodcastEpisodeList from "./PodcastEpisodeList";
import PodcastSubscriptionSettingsModal from "../PodcastSubscriptionSettingsModal";
import PaneSection from "@/components/ui/PaneSection";
import SectionOpener from "@/components/ui/SectionOpener";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  decodePodcastDetailResponse,
  getPodcastSubscriptionSettingsPatch,
  retryPodcastSubscriptionBackfill,
  type PodcastBackfillRecord,
  type PodcastDetailResponse,
} from "../podcastSubscriptions";
import { subscribeToPodcast } from "@/lib/podcasts/acquisition";
import {
  listLibraryPlacements,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import { usePodcastSubscriptionActions } from "../usePodcastSubscriptionActions";
import { useEpisodeTranscriptController } from "./useEpisodeTranscriptController";
import { usePodcastSubscriptionSettingsModal } from "../usePodcastSubscriptionSettingsModal";
import {
  EPISODE_WIDE_COMMAND_LABELS,
  deriveEpisodeState,
  decodePodcastEpisodeMedia,
  episodeMatchesFilter,
  type EpisodeSort,
  type EpisodeStateFilter,
  type PodcastEpisodeMedia,
} from "./episodeTranscript";
import {
  EPISODE_PLAY_NEXT_ACTION_ID,
  episodeActionBusyKey,
  type EpisodeActionId,
} from "./episodeActionBusy";
import styles from "./page.module.css";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ContributorCredit, MediaAuthors } from "@/lib/contributors/types";
import type { ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { findPaneSearchFocusTarget } from "@/lib/workspace/paneDom";

const EPISODES_PAGE_SIZE = 100;

const MediaAuthorsEditor = lazy(
  () =>
    import(/* @vite-ignore */ "@/components/contributors/MediaAuthorsEditor"),
);

interface PodcastDetailLoadResult {
  detail: PodcastDetailResponse;
  episodes: CollectionPage<PodcastEpisodeMedia>;
  podcastLibraries: LibraryPlacementOption[];
}

interface PodcastDetailSnapshot {
  readonly detail: PodcastDetailResponse;
  readonly episodes: readonly PodcastEpisodeMedia[];
  readonly queryIdentity: string;
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
  readonly exhaustion: "Partial" | "Complete";
  readonly podcastLibraries: readonly LibraryPlacementOption[];
}

const PODCAST_DETAIL_VISIT_DATA = definePaneVisitDataKey<PodcastDetailSnapshot>(
  "PodcastDetail.Episodes",
);
const EMPTY_PODCAST_EPISODES: PodcastEpisodeMedia[] = [];
const EMPTY_PODCAST_LIBRARIES: LibraryPlacementOption[] = [];

function formatBackfillFact(backfill: PodcastBackfillRecord): string {
  const label =
    backfill.state === "Running"
      ? "Backfilling"
      : backfill.state === "SourceLimited"
        ? "Backfill source limited"
        : `Backfill ${backfill.state.toLowerCase()}`;
  return `${label} · ${backfill.processed_count} processed · ${backfill.added_count} added`;
}

export default function PodcastDetailPaneBody() {
  const podcastId = usePaneParam("podcastId");
  const paneRouter = usePaneRouter();
  const paneRuntime = requirePaneRuntime(
    usePaneRuntime(),
    "PodcastDetailPaneBody",
  );
  const activateTarget = paneRuntime.activateTarget;
  const paneSearchParams = usePaneSearchParams();
  const { account: billingAccount } = useBillingAccount();
  const player = useGlobalPlayer();
  const lectern = useLectern();
  const offerCompletionUndo = useCompletionUndo();
  const committedSnapshotRef = useRef<PodcastDetailSnapshot | null>(null);
  const reconciliationPendingRef = useRef(false);
  const reconciliationSuccessRef = useRef<string | null>(null);
  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(
    PODCAST_DETAIL_VISIT_DATA,
    captureCommitted,
  );
  const [controller, setController] = useState<PodcastDetailSnapshot | null>(
    restored,
  );
  const controllerRef = useRef<PodcastDetailSnapshot | null>(restored);
  const [chainEpoch, setChainEpoch] = useState(0);
  const clearAllVisitData = useClearAllPaneVisitData();
  const detail = controller?.detail ?? null;
  const episodes = useMemo(
    () =>
      controller === null ? EMPTY_PODCAST_EPISODES : [...controller.episodes],
    [controller],
  );
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
    SetStateAction<LibraryPlacementOption[]>
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
  const episodeQueryIdentity = [
    podcastId,
    episodeStateFilter,
    episodeSort,
  ].join("\u0000");
  const busyEpisodeActionKeys = useStringIdSet();
  const episodeListRegionRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusNeighborRef = useRef<string | null | undefined>(undefined);
  const pendingFocusRafRef = useRef(0);
  const captureEpisodeFocusNeighbor = useCallback((removedId: string) => {
    const region = episodeListRegionRef.current;
    const row = region?.querySelector<HTMLElement>(
      `[data-collection-row-id="${CSS.escape(removedId)}"]`,
    );
    if (!region || !row) {
      pendingFocusNeighborRef.current = undefined;
      return;
    }
    const rows = Array.from(
      region.querySelectorAll<HTMLElement>("[data-collection-row-id]"),
    );
    const index = rows.indexOf(row);
    const neighbor = rows[index + 1] ?? rows[index - 1] ?? null;
    pendingFocusNeighborRef.current = neighbor?.dataset.collectionRowId ?? null;
  }, []);
  const beginEpisodeAction = useCallback(
    (mediaId: string, actionId: EpisodeActionId): string | null => {
      const key = episodeActionBusyKey(mediaId, actionId);
      if (busyEpisodeActionKeys.has(key)) return null;
      busyEpisodeActionKeys.add(key);
      return key;
    },
    [busyEpisodeActionKeys],
  );
  const finishEpisodeAction = useCallback(
    (key: string) => busyEpisodeActionKeys.remove(key),
    [busyEpisodeActionKeys],
  );
  const markingEpisodeIds = useStringIdSet();
  const [markAllAsPlayedBusy, setMarkAllAsPlayedBusy] = useState(false);
  const expandedShowNotesMediaIds = useStringIdSet();
  const episodeUrlSyncedRef = useRef(false);
  const [loading, setLoading] = useState(restored === null);
  const [suppressInitialLoad, setSuppressInitialLoad] = useState(
    restored !== null,
  );
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [backfillRetryBusy, setBackfillRetryBusy] = useState(false);
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
      clearAllVisitData();
    },
  });
  const [authorsEditorMounted, setAuthorsEditorMounted] = useState(false);
  const [authorsEditorOpen, setAuthorsEditorOpen] = useState(false);
  const [authorsEditorMediaId, setAuthorsEditorMediaId] = useState<
    string | null
  >(null);
  const [authorsEditorTrigger, setAuthorsEditorTrigger] =
    useState<HTMLButtonElement | null>(null);
  const authorsEditorEpisode =
    episodes.find((episode) => episode.id === authorsEditorMediaId) ?? null;
  const openEpisodeAuthorsEditor = useCallback(
    (episode: PodcastEpisodeMedia, { triggerEl }: ActionSelectDetail) => {
      setAuthorsEditorMediaId(episode.id);
      setAuthorsEditorTrigger(triggerEl);
      setAuthorsEditorMounted(true);
      setAuthorsEditorOpen(true);
    },
    [],
  );
  const transcriptionAllowed = billingAccount?.can_transcribe === true;

  useSetPaneLabel(detail?.podcast.title ?? (loading ? null : "Podcast"));

  const { clear: clearExpandedShowNotesMediaIds } = expandedShowNotesMediaIds;
  const closeSettingsModal = settingsModal.close;
  const podcastDetailCacheKey =
    podcastId && !suppressInitialLoad
      ? [
          "podcast-detail",
          podcastId,
          episodeStateFilter,
          episodeSort,
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
  const previousEpisodeQueryIdentityRef = useRef(episodeQueryIdentity);
  useLayoutEffect(() => {
    if (previousEpisodeQueryIdentityRef.current === episodeQueryIdentity) {
      return;
    }
    previousEpisodeQueryIdentityRef.current = episodeQueryIdentity;
    reload();
  }, [episodeQueryIdentity, reload]);

  const transcript = useEpisodeTranscriptController({
    podcastId: podcastId ?? "",
    selection: { state: episodeStateFilter },
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
        state: episodeStateFilter,
        sort: episodeSort,
      });

      const fetchOptions = signal ? { signal } : undefined;
      const [detailResp, episodesResp] = await Promise.all([
        apiFetch<unknown>(`/api/podcasts/${podcastId}`, fetchOptions),
        apiFetch<unknown>(
          `/api/podcasts/${podcastId}/episodes?${episodeParams}`,
          fetchOptions,
        ),
      ]);
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const decodedDetail = decodePodcastDetailResponse(detailResp);
      let podcastLibraries: LibraryPlacementOption[] = [];
      if (decodedDetail.subscription) {
        podcastLibraries = await listLibraryPlacements(
          { kind: "Podcast", id: podcastId },
          { signal },
        );
      }
      return {
        detail: decodedDetail,
        episodes: decodeCollectionPage(episodesResp, decodePodcastEpisodeMedia),
        podcastLibraries,
      };
    },
    [episodeSort, episodeStateFilter, podcastId],
  );

  const applyPodcastDetailLoad = useCallback(
    (result: PodcastDetailLoadResult) => {
      reconciliationPendingRef.current = false;
      const snapshot: PodcastDetailSnapshot = {
        detail: result.detail,
        episodes: result.episodes.items,
        queryIdentity: episodeQueryIdentity,
        collectionRevision: result.episodes.collectionRevision,
        nextCursor: result.episodes.nextCursor,
        exhaustion:
          result.episodes.nextCursor.kind === "Absent" ? "Complete" : "Partial",
        podcastLibraries: result.podcastLibraries,
      };
      controllerRef.current = snapshot;
      setController(snapshot);
      setChainEpoch((epoch) => epoch + 1);
      clearExpandedShowNotesMediaIds();
      resetForecasts();
      closeSettingsModal();
    },
    [
      clearExpandedShowNotesMediaIds,
      closeSettingsModal,
      episodeQueryIdentity,
      resetForecasts,
    ],
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
      const successTitle = reconciliationSuccessRef.current;
      reconciliationSuccessRef.current = null;
      setError(
        successTitle === null
          ? null
          : { severity: "success", title: successTitle },
      );
      setLoading(false);
      return;
    }

    if (podcastDetailResource.status === "error") {
      reconciliationSuccessRef.current = null;
      setError(
        toFeedback(podcastDetailResource.error, {
          fallback: "Failed to load podcast detail",
        }),
      );
      setLoading(false);
    }
  }, [applyPodcastDetailLoad, podcastDetailResource, podcastId]);

  useLayoutEffect(() => {
    controllerRef.current = controller;
    committedSnapshotRef.current = reconciliationPendingRef.current
      ? null
      : controller;
  }, [controller]);

  usePaneReturnReady((!loading && controller !== null) || error !== null);

  useEffect(() => {
    if (!podcastId) {
      return;
    }
    const params = new URLSearchParams();
    params.set("state", episodeStateFilter);
    params.set("sort", episodeSort);
    const nextHref = `/podcasts/${podcastId}?${params.toString()}`;
    const transitionOptions = episodeUrlSyncedRef.current
      ? { viewTransition: { kind: "collection-reflow" as const } }
      : undefined;
    episodeUrlSyncedRef.current = true;
    paneRouter.replace(nextHref, transitionOptions);
  }, [episodeSort, episodeStateFilter, paneRouter, podcastId]);

  const loadEpisodePage = useCallback(
    async (
      cursor: CollectionCursor,
      revision: CollectionRevision,
      signal: AbortSignal,
    ) => {
      if (!podcastId) {
        throw new Error("Podcast id is missing");
      }
      const episodeParams = new URLSearchParams({
        limit: String(EPISODES_PAGE_SIZE),
        state: episodeStateFilter,
        sort: episodeSort,
        cursor,
        collection_revision: String(revision),
      });
      const response = await apiFetch<unknown>(
        `/api/podcasts/${podcastId}/episodes?${episodeParams}`,
        { signal },
      );
      return decodeCollectionPage(response, decodePodcastEpisodeMedia);
    },
    [episodeSort, episodeStateFilter, podcastId],
  );
  const commitEpisodePage = useCallback(
    (page: CollectionPage<PodcastEpisodeMedia>) => {
      const current = controllerRef.current;
      if (
        current === null ||
        page.collectionRevision !== current.collectionRevision
      ) {
        throw new Error("Podcast episode continuation revision mismatch");
      }
      const seen = new Set(current.episodes.map((episode) => episode.id));
      const nextEpisodes = [...current.episodes];
      for (const episode of page.items) {
        if (seen.has(episode.id)) continue;
        seen.add(episode.id);
        nextEpisodes.push(episode);
      }
      const next: PodcastDetailSnapshot = {
        ...current,
        episodes: nextEpisodes,
        nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      controllerRef.current = next;
      setController(next);
      return nextEpisodes.length;
    },
    [],
  );
  const episodeExhaustion = useExhaustivePagination({
    active:
      paneRuntime.isActive &&
      controller !== null &&
      controller.queryIdentity === episodeQueryIdentity &&
      !reconciliationPendingRef.current,
    chainKey: [podcastId, episodeStateFilter, episodeSort, chainEpoch].join(
      ":",
    ),
    cursor: controller?.nextCursor ?? { kind: "Absent" },
    collectionRevision:
      controller?.collectionRevision ?? (0 as CollectionRevision),
    itemCount: episodes.length,
    loadPage: loadEpisodePage,
    commitPage: commitEpisodePage,
    refresh: reload,
  });
  const episodeFilterNodes = useMemo(
    () => (
      <>
        <div className={styles.episodeFilterPills}>
          {(
            [
              ["all", "All"],
              ["unplayed", "Unplayed"],
              ["in_progress", "In Progress"],
              ["played", "Played"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant="pill"
              size="sm"
              className={styles.episodeFilterPill}
              aria-pressed={episodeStateFilter === value}
              onClick={() => setEpisodeStateFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <label className={styles.episodeSortLabel}>
          Episode sort
          <Select
            size="sm"
            aria-label="Episode sort"
            value={episodeSort}
            onChange={(event) =>
              setEpisodeSort(event.target.value as EpisodeSort)
            }
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="duration_asc">Shortest</option>
            <option value="duration_desc">Longest</option>
          </Select>
        </label>
      </>
    ),
    [episodeSort, episodeStateFilter],
  );
  const getEpisodeRowStatus = useCallback(
    (query: string) => {
      const visibleCount = episodes.filter((episode) =>
        matchesPaneFilterQuery(query, [
          episode.title,
          ...episode.contributors.flatMap((credit) => [
            credit.contributor_display_name ?? "",
            credit.credited_name,
          ]),
        ]),
      ).length;
      return episodeExhaustion.kind === "Complete"
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: episodes.length,
            unit: { singular: "episode", plural: "episodes" },
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: episodes.length,
            unit: { singular: "episode", plural: "episodes" },
          };
    },
    [episodeExhaustion.kind, episodes],
  );
  const episodeFilterRows = usePaneFilterRows({
    sourceKey: `PodcastDetail.Episodes:${podcastId ?? ""}`,
    inputLabel: "Filter podcast episodes",
    placeholder: "Filter episodes",
    getRowStatus: getEpisodeRowStatus,
    activeDomainControlCount:
      Number(episodeStateFilter !== "all") + Number(episodeSort !== "newest"),
    filters: episodeFilterNodes,
  });
  const visibleEpisodes = useMemo(
    () =>
      episodes.filter((episode) =>
        matchesPaneFilterQuery(episodeFilterRows.query, [
          episode.title,
          ...episode.contributors.flatMap((credit) => [
            credit.contributor_display_name ?? "",
            credit.credited_name,
          ]),
        ]),
      ),
    [episodeFilterRows.query, episodes],
  );
  const handleEpisodeAuthorsSaved = useCallback(
    (result: MediaAuthors) => {
      if (authorsEditorMediaId === null) return;
      const authorCredits: ContributorCredit[] = result.authors.map(
        (author, index) => ({
          contributor_handle: author.contributorHandle,
          contributor_display_name: author.displayName,
          credited_name: author.creditedName,
          role: "author",
          href: author.href,
          ordinal: index,
        }),
      );
      const editedEpisode = episodes.find(
        (episode) => episode.id === authorsEditorMediaId,
      );
      const nextContributors = editedEpisode
        ? [
            ...authorCredits,
            ...editedEpisode.contributors.filter(
              (credit) => credit.role !== "author",
            ),
          ]
        : [];
      if (
        editedEpisode &&
        !matchesPaneFilterQuery(episodeFilterRows.query, [
          editedEpisode.title,
          ...nextContributors.flatMap((credit) => [
            credit.contributor_display_name ?? "",
            credit.credited_name,
          ]),
        ])
      ) {
        captureEpisodeFocusNeighbor(authorsEditorMediaId);
      }
      setEpisodes((current) =>
        current.map((episode) =>
          episode.id === authorsEditorMediaId
            ? {
                ...episode,
                contributors: [
                  ...authorCredits,
                  ...episode.contributors.filter(
                    (credit) => credit.role !== "author",
                  ),
                ],
                author_mode: result.authorMode,
              }
            : episode,
        ),
      );
      setAuthorsEditorOpen(false);
      clearAllVisitData();
    },
    [
      authorsEditorMediaId,
      captureEpisodeFocusNeighbor,
      clearAllVisitData,
      episodeFilterRows.query,
      episodes,
      setEpisodes,
    ],
  );
  const visibleEpisodeSignature = visibleEpisodes
    .map((episode) => episode.id)
    .join("\u001f");
  useEffect(() => {
    const neighborId = pendingFocusNeighborRef.current;
    if (neighborId === undefined) return;
    const moveFocus = () => {
      if (pendingFocusNeighborRef.current !== neighborId) return;
      pendingFocusNeighborRef.current = undefined;
      const neighbor =
        neighborId === null
          ? null
          : episodeListRegionRef.current?.querySelector<HTMLElement>(
              `[data-collection-row-id="${CSS.escape(neighborId)}"]`,
            );
      const target = neighbor?.querySelector<HTMLElement>(
        'a, button, [tabindex]:not([tabindex="-1"])',
      );
      if (target) {
        target.focus();
        return;
      }
      findPaneSearchFocusTarget(paneRuntime.paneId)?.focus();
    };
    const outer = requestAnimationFrame(() => {
      pendingFocusRafRef.current = requestAnimationFrame(moveFocus);
    });
    pendingFocusRafRef.current = outer;
    return () => cancelAnimationFrame(pendingFocusRafRef.current);
  }, [paneRuntime.paneId, visibleEpisodeSignature]);

  const refreshPodcastSync = useCallback(async () => {
    if (!podcastId || !detail?.subscription) {
      return;
    }
    await actions.refreshSync(podcastId, (patch) => {
      setDetail((prev) =>
        prev && prev.subscription
          ? { ...prev, subscription: { ...prev.subscription, ...patch } }
          : prev,
      );
      reload();
    });
  }, [actions, detail?.subscription, podcastId, reload, setDetail]);

  const unsubscribePodcast = useCallback(async () => {
    if (!podcastId || !detail?.subscription) {
      return;
    }
    await actions.unsubscribe(podcastId, detail.podcast.title, (libraries) => {
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

  const retryBackfill = useCallback(async () => {
    if (
      !podcastId ||
      detail?.subscription?.backfill.state !== "Failed" ||
      backfillRetryBusy
    ) {
      return;
    }
    setBackfillRetryBusy(true);
    setError(null);
    try {
      const result = await retryPodcastSubscriptionBackfill(podcastId);
      if (result.podcastId !== podcastId) {
        throw new TypeError("Podcast backfill Retry changed identity");
      }
      setDetail((current) =>
        current?.subscription
          ? {
              ...current,
              subscription: {
                ...current.subscription,
                backfill: {
                  id: result.backfill.id,
                  state: result.backfill.state,
                  processed_count: result.backfill.processedCount,
                  added_count: result.backfill.addedCount,
                },
              },
            }
          : current,
      );
      clearAllVisitData();
      setError({
        severity: result.outcome === "Retried" ? "success" : "info",
        title:
          result.outcome === "Retried"
            ? "Backlog retry started."
            : "Backlog no longer needs retry.",
      });
    } catch (caught) {
      if (handleUnauthenticatedApiError(caught)) return;
      if (!isApiError(caught) || isSameSystemApiDefect(caught)) throw caught;
      setError(
        toFeedback(caught, { fallback: "Couldn’t retry the podcast backlog." }),
      );
    } finally {
      setBackfillRetryBusy(false);
    }
  }, [
    backfillRetryBusy,
    clearAllVisitData,
    detail?.subscription?.backfill.state,
    podcastId,
    setDetail,
  ]);

  const handleRetryEpisodeProcessing = useCallback(
    async (mediaId: string) => {
      const busyKey = beginEpisodeAction(
        mediaId,
        RESOURCE_ACTION_CATALOG.RetryProcessing.id,
      );
      if (busyKey === null) return;
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
        reload();
      } catch (retryError) {
        if (handleUnauthenticatedApiError(retryError)) return;
        if (!isApiError(retryError) || isSameSystemApiDefect(retryError)) {
          throw retryError;
        }
        setError(
          toFeedback(retryError, {
            fallback: "Failed to retry episode processing",
          }),
        );
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      clearAllVisitData,
      finishEpisodeAction,
      reload,
      setEpisodes,
    ],
  );

  const handleRefreshEpisodeSource = useCallback(
    async (mediaId: string) => {
      const busyKey = beginEpisodeAction(
        mediaId,
        RESOURCE_ACTION_CATALOG.RefreshSource.id,
      );
      if (busyKey === null) return;
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
        reload();
      } catch (refreshError) {
        if (handleUnauthenticatedApiError(refreshError)) return;
        if (!isApiError(refreshError) || isSameSystemApiDefect(refreshError)) {
          throw refreshError;
        }
        setError(
          toFeedback(refreshError, {
            fallback: "Failed to refresh episode source",
          }),
        );
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      clearAllVisitData,
      finishEpisodeAction,
      reload,
      setEpisodes,
    ],
  );

  const handleRetryEpisodeMetadata = useCallback(
    async (mediaId: string) => {
      const busyKey = beginEpisodeAction(
        mediaId,
        RESOURCE_ACTION_CATALOG.RetryMetadata.id,
      );
      if (busyKey === null) return;
      setError(null);
      try {
        await retryMediaMetadata(mediaId);
        setError({
          severity: "success",
          title: "Metadata re-enrichment started.",
        });
        clearAllVisitData();
        reload();
      } catch (metadataError) {
        if (handleUnauthenticatedApiError(metadataError)) return;
        if (
          !isApiError(metadataError) ||
          isSameSystemApiDefect(metadataError)
        ) {
          throw metadataError;
        }
        setError(
          toFeedback(metadataError, {
            fallback: "Failed to re-enrich episode metadata",
          }),
        );
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [beginEpisodeAction, clearAllVisitData, finishEpisodeAction, reload],
  );

  const handleDeleteEpisode = useCallback(
    async (episode: PodcastEpisodeMedia) => {
      const busyKey = beginEpisodeAction(
        episode.id,
        RESOURCE_ACTION_CATALOG.RemoveMedia.id,
      );
      if (busyKey === null) return;
      setError(null);
      try {
        const outcome = await confirmAndDeleteMedia({
          mediaId: episode.id,
          mediaTitle: episode.title,
          confirmRemoval: (message) => window.confirm(message),
        });
        if (outcome.kind === "Cancelled") return;
        captureEpisodeFocusNeighbor(episode.id);
        setEpisodes((prev) =>
          prev.filter((candidate) => candidate.id !== episode.id),
        );
        clearAllVisitData();
        reload();
      } catch (deleteError) {
        if (handleUnauthenticatedApiError(deleteError)) return;
        if (!isApiError(deleteError) || isSameSystemApiDefect(deleteError)) {
          throw deleteError;
        }
        setError(
          toFeedback(deleteError, { fallback: "Failed to delete episode" }),
        );
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      captureEpisodeFocusNeighbor,
      clearAllVisitData,
      finishEpisodeAction,
      reload,
      setEpisodes,
    ],
  );

  const applyEpisodeCompletionState = useCallback(
    (
      episode: PodcastEpisodeMedia,
      isCompleted: boolean,
    ): PodcastEpisodeMedia => {
      if (!isCompleted) {
        return { ...episode, episode_state: "unplayed" };
      }
      const previousListeningState = episode.listening_state;
      return {
        ...episode,
        listening_state: {
          position_ms: previousListeningState?.position_ms ?? 0,
          duration_ms: previousListeningState?.duration_ms ?? null,
          playback_speed: previousListeningState?.playback_speed ?? 1,
        },
        episode_state: "played",
      };
    },
    [],
  );

  const handleMarkEpisodeCompletion = useCallback(
    async (episode: PodcastEpisodeMedia, isCompleted: boolean) => {
      const mediaId = episode.id;
      if (episodeStateFilter !== "all") {
        captureEpisodeFocusNeighbor(mediaId);
      }
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
          const parsedMediaId = assumeMediaId(mediaId);
          const preCompletionSnapshot = lectern.getCanonicalSnapshot() ?? {
            items: [],
          };
          const completedItem =
            preCompletionSnapshot.items.find(
              (item) => item.mediaId === mediaId,
            ) ?? null;
          const result = await lectern.ensureMediaFinished(parsedMediaId);
          offerCompletionUndo({
            mediaId: parsedMediaId,
            preCompletionSnapshot,
            completedItemId: completedItem?.itemId ?? null,
            completionHandle: result.completionHandle,
          });
        } else {
          await lectern.setUnread(assumeMediaId(mediaId));
        }
        clearAllVisitData();
        reload();
      } catch (markError) {
        setEpisodes(previousEpisodes);
        if (handleUnauthenticatedApiError(markError)) return;
        if (!isApiError(markError) || isSameSystemApiDefect(markError)) {
          throw markError;
        }
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
      captureEpisodeFocusNeighbor,
      episodeStateFilter,
      episodes,
      lectern,
      markingEpisodeIds,
      offerCompletionUndo,
      reload,
      setEpisodes,
    ],
  );

  const handleResetEpisodeProgress = useCallback(
    async (mediaId: string) => {
      const busyKey = beginEpisodeAction(
        mediaId,
        RESOURCE_ACTION_CATALOG.ResetProgress.id,
      );
      if (busyKey === null) return;
      setError(null);
      try {
        const outcome = await runProgressReset({
          mediaId: assumeMediaId(mediaId),
          isVideo: false,
          confirmReset: (message) => window.confirm(message),
          resetProgress: lectern.resetProgress,
        });
        if (outcome.kind === "Cancelled") return;
        if (
          episodeStateFilter === "in_progress" ||
          episodeStateFilter === "played"
        ) {
          captureEpisodeFocusNeighbor(mediaId);
        }
        const progressState = outcome.result.progressState.value;
        const listeningState = progressState.listeningState;
        if (listeningState.kind === "Absent") {
          throw new Error("Podcast reset must return listening state");
        }
        const canonicalListeningState = listeningState.value;
        setEpisodes((current) =>
          current.flatMap((episode) => {
            if (episode.id !== mediaId) {
              return [episode];
            }
            const resetEpisode: PodcastEpisodeMedia = {
              ...episode,
              listening_state: {
                position_ms: canonicalListeningState.positionMs,
                duration_ms:
                  canonicalListeningState.durationMs.kind === "Present"
                    ? canonicalListeningState.durationMs.value
                    : null,
                playback_speed: canonicalListeningState.playbackSpeed,
              },
              episode_state: "unplayed",
              progress_resettable: false,
            };
            return episodeMatchesFilter(
              deriveEpisodeState(resetEpisode),
              episodeStateFilter,
            )
              ? [resetEpisode]
              : [];
          }),
        );
        reconciliationSuccessRef.current = "Progress reset.";
        reload();
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        setError(toFeedback(error, { fallback: "Failed to reset progress" }));
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      captureEpisodeFocusNeighbor,
      episodeStateFilter,
      finishEpisodeAction,
      lectern.resetProgress,
      reload,
      setEpisodes,
    ],
  );

  const toggleEpisodeShowNotesExpansion = useCallback(
    (mediaId: string) => {
      if (expandedShowNotesMediaIds.has(mediaId)) {
        expandedShowNotesMediaIds.remove(mediaId);
        return;
      }
      const episode = episodes.find((candidate) => candidate.id === mediaId);
      if (!episode?.has_show_notes) return;
      if (episode.description_text?.trim()) {
        expandedShowNotesMediaIds.add(mediaId);
        return;
      }
      void apiFetch<{ data: { description_text: string | null } }>(
        `/api/media/${mediaId}`,
      )
        .then((response) => {
          setEpisodes((current) =>
            current.map((candidate) =>
              candidate.id === mediaId
                ? {
                    ...candidate,
                    description_text: response.data.description_text,
                  }
                : candidate,
            ),
          );
          expandedShowNotesMediaIds.add(mediaId);
        })
        .catch((loadError) => {
          if (handleUnauthenticatedApiError(loadError)) return;
          setError(
            toFeedback(loadError, { fallback: "Failed to load episode notes" }),
          );
        });
    },
    [episodes, expandedShowNotesMediaIds, setEpisodes],
  );

  const handleMarkAllAsPlayed = useCallback(async () => {
    if (
      episodes.length === 0 ||
      !podcastId ||
      episodeFilterRows.query.trim() ||
      episodeStateFilter === "played"
    ) {
      return;
    }
    if (
      !window.confirm(
        `${EPISODE_WIDE_COMMAND_LABELS[episodeStateFilter].markPlayed}?`,
      )
    ) {
      return;
    }
    setMarkAllAsPlayedBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/podcasts/${podcastId}/episodes/mark-played`, {
        method: "POST",
        body: JSON.stringify({
          state: episodeStateFilter,
        }),
      });
      reconciliationSuccessRef.current = "Episodes marked as played.";
      reload();
    } catch (markError) {
      if (handleUnauthenticatedApiError(markError)) return;
      setError(
        toFeedback(markError, {
          fallback: "Failed to mark episodes as played",
        }),
      );
    } finally {
      setMarkAllAsPlayedBusy(false);
    }
  }, [
    episodeFilterRows.query,
    episodeStateFilter,
    episodes,
    podcastId,
    reload,
  ]);

  // Which episodes are already On Lectern, from the canonical Lectern snapshot
  // (replaces the deleted player queue). Empty until the snapshot is Ready.
  const lecternItemsByMediaId = useMemo<
    ReadonlyMap<string, LecternItemId>
  >(() => {
    const snapshot = lectern.resource;
    if (snapshot.status !== "ready") {
      return new Map<string, LecternItemId>();
    }
    return new Map(
      snapshot.data.items.map((item) => [item.mediaId, item.itemId]),
    );
  }, [lectern.resource]);

  // "Play next" is disabled/no-op for the media that is the active Lectern
  // origin's descriptor (spec §5.1 "targeting the current origin is disabled").
  const playNextDisabledMediaId = useMemo<string | null>(() => {
    const session = canonicalSessionOfGlobalState(player.state);
    return session?.origin.kind === "Lectern"
      ? session.descriptor.mediaId
      : null;
  }, [player.state]);

  // Play next: place After the exact Lectern origin item, else at the head
  // (spec §5.1). Add to Lectern: append Last.
  const runEpisodeLecternMutation = useCallback(
    async (
      mediaId: string,
      actionId: EpisodeActionId,
      execute: () => Promise<unknown>,
      failure: string,
    ) => {
      const busyKey = beginEpisodeAction(mediaId, actionId);
      if (busyKey === null) return;
      setError(null);
      try {
        await execute();
        clearAllVisitData();
      } catch (lecternError) {
        if (handleUnauthenticatedApiError(lecternError)) return;
        if (!isApiError(lecternError) || isSameSystemApiDefect(lecternError)) {
          throw lecternError;
        }
        setError(toFeedback(lecternError, { fallback: failure }));
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [beginEpisodeAction, clearAllVisitData, finishEpisodeAction],
  );

  const handlePlayNext = useCallback(
    async (mediaId: string) => {
      const session = canonicalSessionOfGlobalState(player.state);
      const placement: Placement =
        session && session.origin.kind === "Lectern"
          ? { kind: "After", itemId: session.origin.itemId }
          : { kind: "First" };
      await runEpisodeLecternMutation(
        mediaId,
        EPISODE_PLAY_NEXT_ACTION_ID,
        () =>
          lectern.placeItems({
            mediaIds: [assumeMediaId(mediaId)],
            placement,
          }),
        "Failed to place episode next on Lectern",
      );
    },
    [lectern, player.state, runEpisodeLecternMutation],
  );

  const handleAddToLectern = useCallback(
    async (mediaId: string) => {
      await runEpisodeLecternMutation(
        mediaId,
        RESOURCE_ACTION_CATALOG.AddToLectern.id,
        () =>
          lectern.placeItems({
            mediaIds: [assumeMediaId(mediaId)],
            placement: { kind: "Last" },
          }),
        "Failed to add episode to Lectern",
      );
    },
    [lectern, runEpisodeLecternMutation],
  );

  const handleRemoveFromLectern = useCallback(
    async (mediaId: string, itemId: LecternItemId) => {
      await runEpisodeLecternMutation(
        mediaId,
        RESOURCE_ACTION_CATALOG.RemoveFromLectern.id,
        () => lectern.removeItem(itemId),
        "Failed to remove episode from Lectern",
      );
    },
    [lectern, runEpisodeLecternMutation],
  );
  const activeSubscription = detail?.subscription ?? null;
  const paneBusyIds = new Set<ResourceActionId>();
  if (refreshSyncBusy) {
    paneBusyIds.add(RESOURCE_ACTION_CATALOG.RefreshPodcast.id);
  }
  if (unsubscribeBusy) {
    paneBusyIds.add(RESOURCE_ACTION_CATALOG.UnsubscribePodcast.id);
  }
  const paneOptions = podcastResourceOptions({
    settings: activeSubscription
      ? { kind: "Available", execute: openSettingsModal }
      : { kind: "Unavailable" },
    refreshSync: activeSubscription
      ? { kind: "Available", execute: refreshPodcastSync }
      : { kind: "Unavailable" },
    subscription: activeSubscription
      ? { kind: "Subscribed", execute: unsubscribePodcast }
      : { kind: "Unavailable" },
    busyIds: paneBusyIds,
  });

  const connectionsComposerController = useConnectionsComposerController({
    scheme: "podcast",
    id: podcastId ?? "",
  });
  const connectionsBody = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "podcast", id: podcastId ?? "" }}
        composerController={connectionsComposerController}
        activateTarget={activateTarget}
      />
    ),
    [activateTarget, connectionsComposerController, podcastId],
  );
  const { companionAction } = useResourceInspector({
    scheme: "podcast",
    handle: podcastId,
    bodies: { linkedItems: connectionsBody },
  });
  usePanePrimaryChrome({
    actions: companionAction ? [companionAction] : [],
    menu:
      podcastId && detail
        ? {
            kind: "ResourceMenu",
            target: routeResourceActionSubject({
              scheme: "podcast",
              id: podcastId,
              href: `/podcasts/${podcastId}`,
            }),
            groups: {
              core: [],
              ...paneOptions,
              view: [],
            },
          }
        : undefined,
    header: {
      kind: "section",
      folio:
        !loading && episodeExhaustion.kind === "Complete"
          ? {
              kind: "count",
              value: episodeExhaustion.itemCount,
              unit: "episode",
            }
          : { kind: "none" },
      pending: loading || episodeExhaustion.kind !== "Complete",
    },
    search: episodeFilterRows.publication,
  });

  const podcastLibraryCount = podcastLibraries.filter(
    (library) => library.isInLibrary,
  ).length;
  const episodePaneContent = (
    <div ref={episodeListRegionRef} style={{ display: "contents" }}>
      <PodcastEpisodeList
        episodes={visibleEpisodes}
        filterQuery={episodeFilterRows.query}
        loading={loading}
        error={error}
        episodeStateFilter={episodeStateFilter}
        transcript={transcript}
        transcriptionAllowed={transcriptionAllowed}
        busyEpisodeActionKeys={busyEpisodeActionKeys}
        markingEpisodeIds={markingEpisodeIds}
        expandedShowNotesMediaIds={expandedShowNotesMediaIds}
        lecternItemsByMediaId={lecternItemsByMediaId}
        playNextDisabledMediaId={playNextDisabledMediaId}
        lecternReady={lectern.resource.status === "ready"}
        matchingEpisodeCount={episodes.length}
        markAllAsPlayedBusy={markAllAsPlayedBusy}
        collectionBusy={episodeExhaustion.kind === "Draining"}
        exhaustion={episodeExhaustion}
        onMarkAllAsPlayed={() => void handleMarkAllAsPlayed()}
        onToggleShowNotes={toggleEpisodeShowNotesExpansion}
        onPlayNext={handlePlayNext}
        onAddToLectern={handleAddToLectern}
        onRemoveFromLectern={handleRemoveFromLectern}
        onRetry={handleRetryEpisodeProcessing}
        onRefreshSource={handleRefreshEpisodeSource}
        onRetryMetadata={handleRetryEpisodeMetadata}
        onEditAuthors={openEpisodeAuthorsEditor}
        onDelete={handleDeleteEpisode}
        onTogglePlayed={handleMarkEpisodeCompletion}
        onResetProgress={handleResetEpisodeProgress}
      />
    </div>
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
            {detail ? (
              <AcquisitionControl
                kind="Subscribe"
                subscribed={activeSubscription !== null}
                commit={async (command) => {
                  const result = await subscribeToPodcast({
                    target: { kind: "Canonical", podcastId },
                    namedLibraryIds: command.namedLibraryIds,
                    replacementConfirmation: command.replacementConfirmation,
                    idempotencyKey: command.idempotencyKey,
                  });
                  return { href: result.href };
                }}
                onCommitted={() => {
                  clearAllVisitData();
                  reload();
                }}
              />
            ) : null}
          </div>
        </div>
        <PaneSection>
          {loading && <PaneLoadingState />}
          {error && <FeedbackNotice feedback={error} />}
          {!loading && detail && (
            <PodcastOverview
              title={detail.podcast.title}
              image={
                detail.podcast.image_url
                  ? { kind: "Remote", url: detail.podcast.image_url }
                  : { kind: "Absent" }
              }
              contributors={detail.podcast.contributors}
              description={detail.podcast.description}
              facts={[
                activeSubscription ? "Subscribed" : "Not subscribed",
                `In ${pluralize(podcastLibraryCount, "library", "libraries")}`,
                ...(activeSubscription
                  ? [
                      `Sync ${activeSubscription.sync_status}`,
                      formatBackfillFact(activeSubscription.backfill),
                      formatSubscriptionPlaybackSummary(
                        activeSubscription.default_playback_speed,
                        activeSubscription.auto_queue,
                      ),
                    ]
                  : []),
              ]}
              links={[
                ...(detail.podcast.feed_url
                  ? [{ label: "RSS feed", href: detail.podcast.feed_url }]
                  : []),
                ...(detail.podcast.website_url
                  ? [{ label: "Website", href: detail.podcast.website_url }]
                  : []),
              ]}
              note={
                activeSubscription
                  ? "Subscription is active. Manage playback defaults, sync, and library membership from this header."
                  : "Subscribe to save playback defaults and add this show to your libraries."
              }
              error={
                activeSubscription?.sync_error_code
                  ? `${activeSubscription.sync_error_code}${
                      activeSubscription.sync_error_message
                        ? `: ${activeSubscription.sync_error_message}`
                        : ""
                    }`
                  : undefined
              }
            />
          )}
          {activeSubscription?.backfill.state === "Failed" ? (
            <div className={styles.headerButtons}>
              <Button
                size="sm"
                variant="secondary"
                loading={backfillRetryBusy}
                onClick={() => void retryBackfill()}
              >
                Retry backlog
              </Button>
            </div>
          ) : null}
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
      {authorsEditorMounted && authorsEditorEpisode ? (
        <Suspense fallback={null}>
          <MediaAuthorsEditor
            mediaId={authorsEditorEpisode.id}
            open={authorsEditorOpen}
            authors={mapMediaAuthorCredits(authorsEditorEpisode.contributors)}
            authorMode={authorsEditorEpisode.author_mode}
            returnFocusTo={() => authorsEditorTrigger}
            returnFocusFallback={() =>
              document.querySelector<HTMLButtonElement>(
                'button[aria-label="Episode actions"]',
              )
            }
            onClose={() => setAuthorsEditorOpen(false)}
            onSaved={handleEpisodeAuthorsSaved}
          />
        </Suspense>
      ) : null}
    </>
  );
}
