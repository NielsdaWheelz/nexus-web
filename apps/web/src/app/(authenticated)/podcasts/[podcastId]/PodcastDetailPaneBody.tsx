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
import { presenceValueOr, type Presence } from "@/lib/api/presence";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
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
  usePaneIsActive,
  usePaneParam,
  usePaneReturnReady,
  usePaneRuntime,
  requirePaneRuntime,
  usePaneVisitData,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import {
  CANONICAL_PODCAST_EPISODE_VIEW,
  EPISODE_SORTS,
  EPISODE_STATE_FILTERS,
  activeEpisodeControlCount,
  decodePodcastEpisodeView,
  encodePodcastEpisodeView,
  episodeSortLabel,
  episodeStateFilterLabel,
  podcastEpisodeViewQuery,
  type DecodedPodcastEpisodeView,
  type EpisodeSort,
} from "@/lib/podcasts/episodeView";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import {
  canonicalSessionOfGlobalState,
  usePlayerSession,
} from "@/lib/player/globalPlayer";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
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
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import Button from "@/components/ui/Button";
import SelectField from "@/components/ui/SelectField";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  decodePodcastDetailResponse,
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
import { isAbortError } from "@/lib/errors";
import { runPodcastRefresh } from "@/lib/podcasts/refresh";
import type { PaneRefreshPublication } from "@/lib/panes/panePublications";

const EPISODES_PAGE_SIZE = 100;

type PodcastDetailOperation =
  | "Load"
  | "Backfill"
  | "RetryProcessing"
  | "RefreshSource"
  | "RetryMetadata"
  | "DeleteEpisode"
  | "MarkPlayed"
  | "ResetProgress"
  | "LoadNotes"
  | "MarkAllPlayed"
  | "Lectern"
  | "PaneRefresh";

function podcastDetailErrorTitle(operation: PodcastDetailOperation): string {
  switch (operation) {
    case "Load":
      return "Podcast details couldn’t be loaded";
    case "Backfill":
      return "Podcast backlog retry wasn’t started";
    case "RetryProcessing":
      return "Episode processing retry wasn’t started";
    case "RefreshSource":
      return "Episode source refresh wasn’t started";
    case "RetryMetadata":
      return "Episode metadata enrichment wasn’t started";
    case "DeleteEpisode":
      return "Episode wasn’t removed";
    case "MarkPlayed":
      return "Episode state wasn’t changed";
    case "ResetProgress":
      return "Episode progress wasn’t reset";
    case "LoadNotes":
      return "Episode notes couldn’t be loaded";
    case "MarkAllPlayed":
      return "Episodes weren’t marked as played";
    case "Lectern":
      return "Lectern wasn’t updated";
    case "PaneRefresh":
      return "Podcast wasn’t refreshed";
  }
}

/** Finite product-copy adapter for podcast-detail endpoint failures. */
function podcastDetailErrorMessage(
  error: unknown,
  operation: PodcastDetailOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  const title = podcastDetailErrorTitle(operation);
  switch (error.code) {
    case "E_NETWORK":
      return { tone: "Danger", title, message: "Check your connection and retry.", requestId };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "The server took too long to respond. Retry the action.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return { tone: "Danger", title, message: "Wait a moment, then retry.", requestId };
    case "E_MEDIA_NOT_FOUND":
    case "E_PODCAST_NOT_FOUND":
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This podcast or episode is no longer available. Refresh the pane.",
        requestId,
      };
    case "E_MEDIA_NOT_READY":
      return {
        tone: "Danger",
        title,
        message: "This episode is still preparing. Wait for it to settle, then retry.",
        requestId,
      };
    case "E_RETRY_INVALID_STATE":
      if (
        operation !== "RetryProcessing" &&
        operation !== "RefreshSource" &&
        operation !== "RetryMetadata"
      ) {
        throw error;
      }
      return {
        tone: "Danger",
        title,
        message:
          operation === "RetryMetadata"
            ? "Metadata can be retried only after this episode is ready to read."
            : "The source state changed. Review its current status before trying again.",
        requestId,
      };
    case "E_RETRY_NOT_ALLOWED":
      if (operation !== "RetryProcessing" && operation !== "RefreshSource") {
        throw error;
      }
      return {
        tone: "Danger",
        title,
        message:
          operation === "RetryProcessing"
            ? "This source can’t be retried. Add a new source instead."
            : "This source can’t be refreshed. Add a new source instead.",
        requestId,
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title,
        message: "This account can’t make that change.",
        requestId,
      };
    case "E_CONFLICT":
    case "E_READER_STATE_CONFLICT":
    case "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH":
      return {
        tone: "Danger",
        title,
        message: "The episode changed. Refresh the pane, then retry.",
        requestId,
      };
    case "E_BAD_REQUEST":
    case "E_INVALID_REQUEST":
      if (error.code === "E_BAD_REQUEST" && operation !== "PaneRefresh") {
        throw error;
      }
      return {
        tone: "Danger",
        title,
        message: "The requested change is no longer valid. Refresh the pane and retry.",
        requestId,
      };
    default:
      throw error;
  }
}

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

interface PendingPodcastDetailRevalidation {
  readonly nonce: number;
  readonly sourceKey: string | null;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
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

function formatEpisodeUpdateStatus(
  status: NonNullable<PodcastDetailResponse["subscription"]>["sync_status"],
): string {
  switch (status) {
    case "Pending":
      return "Episode updates pending";
    case "Running":
      return "Checking for new episodes";
    case "Complete":
      return "Episode updates current";
    case "SourceLimited":
      return "Episode updates source-limited";
    case "Failed":
      return "Episode updates failed";
  }
}

export default function PodcastDetailPaneBody() {
  const podcastId = usePaneParam("podcastId");
  const paneRuntime = requirePaneRuntime(
    usePaneRuntime(),
    "PodcastDetailPaneBody",
  );
  const isPaneActive = usePaneIsActive();
  const activateTarget = paneRuntime.activateTarget;
  const { account: billingAccount } = useBillingAccount();
  const { state: playerState } = usePlayerSession();
  const lectern = useLectern();
  const offerCompletionUndo = useCompletionUndo();
  const committedSnapshotRef = useRef<PodcastDetailSnapshot | null>(null);
  const refreshFallbackSnapshotRef =
    useRef<PodcastDetailSnapshot | null>(null);
  const reconciliationPendingRef = useRef(false);
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
  // The pane URL owns the episode view through a strict, total codec; `view` is
  // null only when the URL is Invalid, which is a terminal, user-recoverable
  // state that requests nothing.
  const episodeViewCodec = useMemo(
    () => ({
      basePath: `/podcasts/${podcastId ?? ""}`,
      decode: decodePodcastEpisodeView,
      encode: (decoded: DecodedPodcastEpisodeView, current: URLSearchParams) =>
        encodePodcastEpisodeView(
          decoded.kind === "Valid"
            ? decoded.view
            : CANONICAL_PODCAST_EPISODE_VIEW,
          current,
        ),
      replaceOptions: {
        viewTransition: { kind: "collection-reflow" } as const,
      },
    }),
    [podcastId],
  );
  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(episodeViewCodec);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  // The request identity is the podcast plus the exact API query the view names.
  const episodeQueryIdentity =
    view === null
      ? null
      : [podcastId, podcastEpisodeViewQuery(view).toString()].join("\u0000");
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
  const unconfirmedMetadataMediaIds = useStringIdSet();
  const [markAllAsPlayedBusy, setMarkAllAsPlayedBusy] = useState(false);
  const expandedShowNotesMediaIds = useStringIdSet();
  const [loading, setLoading] = useState(restored === null);
  const [suppressInitialLoad, setSuppressInitialLoad] = useState(
    restored !== null,
  );
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [metadataRetryUnconfirmedNotice, setMetadataRetryUnconfirmedNotice] =
    useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const captureDetailError = useCallback(
    (detailError: unknown, operation: PodcastDetailOperation) => {
      try {
        setError(podcastDetailErrorMessage(detailError, operation));
      } catch (defect) {
        setAsyncDefect({ error: defect });
      }
    },
    [],
  );
  const [reloadNonce, setReloadNonce] = useState(0);
  const reloadNonceRef = useRef(0);
  const pendingPodcastDetailRevalidationRef =
    useRef<PendingPodcastDetailRevalidation | null>(null);
  const completedPodcastDetailRevalidationNonceRef =
    useRef<number | null>(null);
  const [backfillRetryBusy, setBackfillRetryBusy] = useState(false);
  const actions = usePodcastSubscriptionActions(setError);
  const unsubscribeBusy = podcastId
    ? actions.unsubscribingPodcastIds.ids.has(podcastId)
    : false;
  const settingsModal = usePodcastSubscriptionSettingsModal({
    onSaved: (response) => {
      if (response.podcast_id !== podcastId) return;
      setDetail((prev) =>
        prev && prev.subscription
          ? {
              ...prev,
              subscription: {
                ...prev.subscription,
                default_playback_speed: response.default_playback_speed,
                pause_shortening_mode: response.pause_shortening_mode,
                auto_queue: response.auto_queue,
                updated_at: response.updated_at,
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
    episodeQueryIdentity !== null && !suppressInitialLoad
      ? ["podcast-detail", episodeQueryIdentity, reloadNonce].join(":")
      : null;
  const rejectPendingPodcastDetailRevalidation = useCallback(
    (refreshError: unknown) => {
      const pending = pendingPodcastDetailRevalidationRef.current;
      pendingPodcastDetailRevalidationRef.current = null;
      completedPodcastDetailRevalidationNonceRef.current = null;
      if (!pending) return;
      pending.removeAbortListener();
      pending.reject(refreshError);
    },
    [],
  );
  // Abandons the committed chain so the next first page is adopted afresh. A
  // view change needs only this: the view is already part of the request
  // identity.
  const resetEpisodeChain = useCallback(() => {
    rejectPendingPodcastDetailRevalidation(
      new DOMException("Podcast refresh was superseded.", "AbortError"),
    );
    if (committedSnapshotRef.current !== null) {
      refreshFallbackSnapshotRef.current = committedSnapshotRef.current;
    }
    reconciliationPendingRef.current = true;
    committedSnapshotRef.current = null;
    clearAllVisitData();
    setSuppressInitialLoad(false);
  }, [clearAllVisitData, rejectPendingPodcastDetailRevalidation]);
  // A reload keeps the view, so only a fresh nonce makes the request identity
  // differ from the one already loaded.
  const reload = useCallback(() => {
    resetEpisodeChain();
    const nonce = reloadNonceRef.current + 1;
    reloadNonceRef.current = nonce;
    setReloadNonce(nonce);
  }, [resetEpisodeChain]);
  const revalidatePodcastDetail = useCallback(
    (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ??
            new DOMException("Podcast refresh was aborted.", "AbortError"),
        );
      }
      reload();
      const nonce = reloadNonceRef.current;
      const sourceKey = episodeQueryIdentity;
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const pending = pendingPodcastDetailRevalidationRef.current;
          if (pending?.nonce !== nonce) return;
          pendingPodcastDetailRevalidationRef.current = null;
          completedPodcastDetailRevalidationNonceRef.current = null;
          pending.removeAbortListener();
          reconciliationPendingRef.current = false;
          setSuppressInitialLoad(true);
          committedSnapshotRef.current = refreshFallbackSnapshotRef.current;
          refreshFallbackSnapshotRef.current = null;
          setLoading(false);
          reject(
            signal.reason ??
              new DOMException("Podcast refresh was aborted.", "AbortError"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pendingPodcastDetailRevalidationRef.current = {
          nonce,
          sourceKey,
          resolve,
          reject,
          removeAbortListener: () =>
            signal.removeEventListener("abort", onAbort),
        };
        if (signal.aborted) onAbort();
      });
    },
    [episodeQueryIdentity, reload],
  );
  useEffect(
    () => () => {
      rejectPendingPodcastDetailRevalidation(
        new DOMException("Podcast refresh source was replaced.", "AbortError"),
      );
    },
    [
      episodeQueryIdentity,
      podcastId,
      rejectPendingPodcastDetailRevalidation,
    ],
  );
  const previousEpisodeQueryIdentityRef = useRef(episodeQueryIdentity);
  useLayoutEffect(() => {
    if (previousEpisodeQueryIdentityRef.current === episodeQueryIdentity) {
      return;
    }
    previousEpisodeQueryIdentityRef.current = episodeQueryIdentity;
    resetEpisodeChain();
  }, [episodeQueryIdentity, resetEpisodeChain]);

  const transcript = useEpisodeTranscriptController({
    podcastId: podcastId ?? "",
    // No episode commits while the view is Invalid, so the batch transcript
    // command this selection describes is unreachable there.
    selection: { state: (view ?? CANONICAL_PODCAST_EPISODE_VIEW).state },
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
      if (!podcastId || view === null) {
        throw new Error("Podcast episodes require an addressable view");
      }
      const episodeParams = podcastEpisodeViewQuery(view);
      episodeParams.set("limit", String(EPISODES_PAGE_SIZE));

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
    [podcastId, view],
  );

  const applyPodcastDetailLoad = useCallback(
    (result: PodcastDetailLoadResult) => {
      if (episodeQueryIdentity === null) return;
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
      committedSnapshotRef.current = snapshot;
      refreshFallbackSnapshotRef.current = null;
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
    if (!podcastId || view === null) {
      setLoading(false);
      setError(null);
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
      const pending = pendingPodcastDetailRevalidationRef.current;
      if (
        pending?.nonce === reloadNonce &&
        pending.sourceKey === episodeQueryIdentity
      ) {
        completedPodcastDetailRevalidationNonceRef.current = pending.nonce;
      }
      return;
    }

    if (podcastDetailResource.status === "error") {
      reconciliationPendingRef.current = false;
      setSuppressInitialLoad(true);
      committedSnapshotRef.current = refreshFallbackSnapshotRef.current;
      refreshFallbackSnapshotRef.current = null;
      const pending = pendingPodcastDetailRevalidationRef.current;
      captureDetailError(
        podcastDetailResource.error,
        pending?.nonce === reloadNonce ? "PaneRefresh" : "Load",
      );
      setLoading(false);
      if (pending?.nonce === reloadNonce) {
        rejectPendingPodcastDetailRevalidation(podcastDetailResource.error);
      }
    }
  }, [
    applyPodcastDetailLoad,
    captureDetailError,
    episodeQueryIdentity,
    podcastDetailResource,
    podcastId,
    rejectPendingPodcastDetailRevalidation,
    reloadNonce,
    view,
  ]);

  useLayoutEffect(() => {
    controllerRef.current = controller;
    committedSnapshotRef.current = reconciliationPendingRef.current
      ? null
      : controller;
    const pending = pendingPodcastDetailRevalidationRef.current;
    if (
      controller === null ||
      pending === null ||
      completedPodcastDetailRevalidationNonceRef.current !== pending.nonce ||
      pending.sourceKey !== episodeQueryIdentity ||
      controller.queryIdentity !== episodeQueryIdentity ||
      reconciliationPendingRef.current
    ) {
      return;
    }
    completedPodcastDetailRevalidationNonceRef.current = null;
    pendingPodcastDetailRevalidationRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, [controller, episodeQueryIdentity]);

  usePaneReturnReady(
    (!loading && controller !== null) || error !== null || view === null,
  );

  const loadEpisodePage = useCallback(
    async (
      cursor: CollectionCursor,
      revision: CollectionRevision,
      signal: AbortSignal,
    ) => {
      if (!podcastId || view === null) {
        throw new Error("Podcast episodes require an addressable view");
      }
      const episodeParams = podcastEpisodeViewQuery(view);
      episodeParams.set("limit", String(EPISODES_PAGE_SIZE));
      episodeParams.set("cursor", cursor);
      episodeParams.set("collection_revision", String(revision));
      const response = await apiFetch<unknown>(
        `/api/podcasts/${podcastId}/episodes?${episodeParams}`,
        { signal },
      );
      return decodeCollectionPage(response, decodePodcastEpisodeMedia);
    },
    [podcastId, view],
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
      isPaneActive &&
      controller !== null &&
      controller.queryIdentity === episodeQueryIdentity &&
      !reconciliationPendingRef.current,
    chainKey: [episodeQueryIdentity, chainEpoch].join(":"),
    cursor: controller?.nextCursor ?? { kind: "Absent" },
    collectionRevision:
      controller?.collectionRevision ?? (0 as CollectionRevision),
    itemCount: episodes.length,
    loadPage: loadEpisodePage,
    commitPage: commitEpisodePage,
    refresh: reload,
  });
  const activeDomainControlCount =
    view === null ? 0 : activeEpisodeControlCount(view);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  const dismissFilterRowsRef = useRef<() => void>(() => undefined);
  // Clear filters and Reset view both remove themselves by installing the
  // canonical view; the commit that removes them returns focus to Sort by.
  const pendingCommitFocusRef = useRef(false);
  useEffect(() => {
    if (!pendingCommitFocusRef.current) return;
    pendingCommitFocusRef.current = false;
    sortSelectRef.current?.focus();
  }, [view]);
  const resetToCanonicalView = useCallback(() => {
    dismissFilterRowsRef.current();
    pendingCommitFocusRef.current = true;
    setDecodedView({ kind: "Valid", view: CANONICAL_PODCAST_EPISODE_VIEW });
  }, [setDecodedView]);
  const episodeFilterNodes = useMemo(
    () =>
      view === null ? undefined : (
        <>
          <div className={styles.episodeFilterPills}>
            {EPISODE_STATE_FILTERS.map((state) => (
              <Button
                key={state}
                variant="pill"
                size="sm"
                className={styles.episodeFilterPill}
                aria-pressed={view.state === state}
                onClick={() =>
                  setDecodedView({ kind: "Valid", view: { ...view, state } })
                }
              >
                {episodeStateFilterLabel(state)}
              </Button>
            ))}
          </div>
          <SelectField
            layout="Stacked"
            label="Sort by"
            size="sm"
            ref={sortSelectRef}
            value={view.sort}
            onChange={(event) =>
              setDecodedView({
                kind: "Valid",
                view: { ...view, sort: event.target.value as EpisodeSort },
              })
            }
          >
            {EPISODE_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {episodeSortLabel(sort)}
              </option>
            ))}
          </SelectField>
          {activeDomainControlCount > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={resetToCanonicalView}
            >
              Clear filters
            </Button>
          ) : null}
        </>
      ),
    [activeDomainControlCount, resetToCanonicalView, setDecodedView, view],
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
    activeDomainControlCount,
    filters: episodeFilterNodes,
  });
  dismissFilterRowsRef.current = episodeFilterRows.publication.onDismiss;
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
      setError(null);
    } catch (caught) {
      if (handleUnauthenticatedApiError(caught)) return;
      captureDetailError(caught, "Backfill");
    } finally {
      setBackfillRetryBusy(false);
    }
  }, [
    backfillRetryBusy,
    captureDetailError,
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
        setError(null);
        clearAllVisitData();
        reload();
      } catch (retryError) {
        if (handleUnauthenticatedApiError(retryError)) return;
        captureDetailError(retryError, "RetryProcessing");
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      captureDetailError,
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
        setError(null);
        clearAllVisitData();
        reload();
      } catch (refreshError) {
        if (handleUnauthenticatedApiError(refreshError)) return;
        captureDetailError(refreshError, "RefreshSource");
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      captureDetailError,
      clearAllVisitData,
      finishEpisodeAction,
      reload,
      setEpisodes,
    ],
  );

  const handleRetryEpisodeMetadata = useCallback(
    async (mediaId: string) => {
      if (unconfirmedMetadataMediaIds.has(mediaId)) return;
      const busyKey = beginEpisodeAction(
        mediaId,
        RESOURCE_ACTION_CATALOG.RetryMetadata.id,
      );
      if (busyKey === null) return;
      setError(null);
      try {
        await retryMediaMetadata(mediaId);
        clearAllVisitData();
        reload();
      } catch (metadataError) {
        if (handleUnauthenticatedApiError(metadataError)) return;
        if (
          isApiError(metadataError) &&
          (metadataError.code === "E_NETWORK" ||
            metadataError.code === "E_UPSTREAM_TIMEOUT")
        ) {
          unconfirmedMetadataMediaIds.add(mediaId);
          setMetadataRetryUnconfirmedNotice({
            tone: "Warning",
            title: "Metadata request couldn’t be confirmed",
            message: "Its status is being checked. Don’t start it again yet.",
            requestId: metadataError.requestId,
          });
          clearAllVisitData();
          reload();
          return;
        }
        captureDetailError(metadataError, "RetryMetadata");
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      captureDetailError,
      clearAllVisitData,
      finishEpisodeAction,
      reload,
      unconfirmedMetadataMediaIds,
    ],
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
        captureDetailError(deleteError, "DeleteEpisode");
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      captureDetailError,
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
        },
        episode_state: "played",
      };
    },
    [],
  );

  const handleMarkEpisodeCompletion = useCallback(
    async (episode: PodcastEpisodeMedia, isCompleted: boolean) => {
      if (view === null) return;
      const mediaId = episode.id;
      if (view.state !== "all") {
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
              view.state,
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
        captureDetailError(markError, "MarkPlayed");
      } finally {
        markingEpisodeIds.remove(mediaId);
      }
    },
    [
      applyEpisodeCompletionState,
      captureDetailError,
      clearAllVisitData,
      captureEpisodeFocusNeighbor,
      episodes,
      lectern,
      markingEpisodeIds,
      offerCompletionUndo,
      reload,
      setEpisodes,
      view,
    ],
  );

  const handleResetEpisodeProgress = useCallback(
    async (mediaId: string) => {
      if (view === null) return;
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
        if (view.state === "in_progress" || view.state === "played") {
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
                },
              episode_state: "unplayed",
              progress_resettable: false,
            };
            return episodeMatchesFilter(
              deriveEpisodeState(resetEpisode),
              view.state,
            )
              ? [resetEpisode]
              : [];
          }),
        );
        reload();
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        captureDetailError(error, "ResetProgress");
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [
      beginEpisodeAction,
      captureDetailError,
      captureEpisodeFocusNeighbor,
      finishEpisodeAction,
      lectern.resetProgress,
      reload,
      setEpisodes,
      view,
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
          captureDetailError(loadError, "LoadNotes");
        });
    },
    [captureDetailError, episodes, expandedShowNotesMediaIds, setEpisodes],
  );

  const handleMarkAllAsPlayed = useCallback(async () => {
    if (
      episodes.length === 0 ||
      !podcastId ||
      view === null ||
      episodeFilterRows.query.trim() ||
      view.state === "played"
    ) {
      return;
    }
    if (
      !window.confirm(`${EPISODE_WIDE_COMMAND_LABELS[view.state].markPlayed}?`)
    ) {
      return;
    }
    setMarkAllAsPlayedBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/podcasts/${podcastId}/episodes/mark-played`, {
        method: "POST",
        body: JSON.stringify({ state: view.state }),
      });
      reload();
    } catch (markError) {
      if (handleUnauthenticatedApiError(markError)) return;
      captureDetailError(markError, "MarkAllPlayed");
    } finally {
      setMarkAllAsPlayedBusy(false);
    }
  }, [
    captureDetailError,
    episodeFilterRows.query,
    episodes,
    podcastId,
    reload,
    view,
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
    const session = canonicalSessionOfGlobalState(playerState);
    return session?.origin.kind === "Lectern"
      ? session.descriptor.mediaId
      : null;
  }, [playerState]);

  // Play next: place After the exact Lectern origin item, else at the head
  // (spec §5.1). Add to Lectern: append Last.
  const runEpisodeLecternMutation = useCallback(
    async (
      mediaId: string,
      actionId: EpisodeActionId,
      execute: () => Promise<unknown>,
    ) => {
      const busyKey = beginEpisodeAction(mediaId, actionId);
      if (busyKey === null) return;
      setError(null);
      try {
        await execute();
        clearAllVisitData();
      } catch (lecternError) {
        if (handleUnauthenticatedApiError(lecternError)) return;
        captureDetailError(lecternError, "Lectern");
      } finally {
        finishEpisodeAction(busyKey);
      }
    },
    [beginEpisodeAction, captureDetailError, clearAllVisitData, finishEpisodeAction],
  );

  const handlePlayNext = useCallback(
    async (mediaId: string) => {
      const session = canonicalSessionOfGlobalState(playerState);
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
      );
    },
    [lectern, playerState, runEpisodeLecternMutation],
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
      );
    },
    [lectern, runEpisodeLecternMutation],
  );
  const executeRefresh = useCallback<PaneRefreshPublication["execute"]>(
    async ({ signal, reportProgress }) => {
      if (!podcastId) {
        return {
          kind: "Failed",
          announcement: "Podcast failed to refresh",
        };
      }
      try {
        const result = await runPodcastRefresh(
          { kind: "Podcast", podcastId },
          {
            signal,
            onProgress: ({ finishedCount, requestedCount }) =>
              reportProgress({
                kind: "Determinate",
                finishedCount,
                requestedCount,
              }),
          },
        );
        await revalidatePodcastDetail(signal);
        return {
          kind: result.kind,
          announcement: result.announcement,
        };
      } catch (refreshError: unknown) {
        if (isAbortError(refreshError)) throw refreshError;
        if (!handleUnauthenticatedApiError(refreshError)) {
          try {
            podcastDetailErrorMessage(refreshError, "PaneRefresh");
          } catch (defect) {
            setAsyncDefect({ error: defect });
          }
        }
        return {
          kind: "Failed",
          announcement: "Podcast failed to refresh",
        };
      }
    },
    [podcastId, revalidatePodcastDetail],
  );
  const activeSubscription = detail?.subscription ?? null;
  const paneBusyIds = new Set<ResourceActionId>();
  if (unsubscribeBusy) {
    paneBusyIds.add(RESOURCE_ACTION_CATALOG.UnsubscribePodcast.id);
  }
  const paneOptions = podcastResourceOptions({
    settings: activeSubscription
      ? { kind: "Available", execute: openSettingsModal }
      : { kind: "Unavailable" },
    checkForNewEpisodes: { kind: "Unavailable" },
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
    refresh:
      podcastId && activeSubscription
        ? {
            sourceKey: `Podcast.Detail:${episodeQueryIdentity}`,
            execute: executeRefresh,
          }
        : undefined,
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
        view !== null && !loading && episodeExhaustion.kind === "Complete"
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

  if (asyncDefect !== null) throw asyncDefect.error;

  const podcastLibraryCount = podcastLibraries.filter(
    (library) => library.isInLibrary,
  ).length;
  const episodePaneContent =
    view === null ? (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid episodes view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: resetToCanonicalView }]}
      />
    ) : (
      <div ref={episodeListRegionRef} style={{ display: "contents" }}>
        <PodcastEpisodeList
          episodes={visibleEpisodes}
          filterQuery={episodeFilterRows.query}
          loading={loading}
          error={error}
          episodeStateFilter={view.state}
          transcript={transcript}
          transcriptionAllowed={transcriptionAllowed}
          busyEpisodeActionKeys={busyEpisodeActionKeys}
          markingEpisodeIds={markingEpisodeIds}
          expandedShowNotesMediaIds={expandedShowNotesMediaIds}
          unconfirmedMetadataMediaIds={unconfirmedMetadataMediaIds.ids}
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
        <FeedbackNotice
          content={{ tone: "Danger", title: "Podcast id is missing." }}
          announcement="Assertive"
        />
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
          {loading && (
            <PaneLoadingState label="Loading podcast…" announcement="Polite" />
          )}
          {error && (
            <FeedbackNotice content={error} announcement="Assertive" />
          )}
          {metadataRetryUnconfirmedNotice && (
            <FeedbackNotice
              content={metadataRetryUnconfirmedNotice}
              announcement="Assertive"
            />
          )}
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
                      formatEpisodeUpdateStatus(activeSubscription.sync_status),
                      formatBackfillFact(activeSubscription.backfill),
                      `${formatPlaybackRate(
                        presenceValueOr(
                          activeSubscription.default_playback_speed,
                          1,
                        ),
                      )} default speed · Auto-queue ${
                        activeSubscription.auto_queue ? "on" : "off"
                      }`,
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
                  ? "Subscription is active. Manage playback defaults, episode updates, and library membership from this header."
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
