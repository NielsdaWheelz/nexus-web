"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { Compass } from "lucide-react";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import {
  decodeCollectionPage,
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import Button from "@/components/ui/Button";
import SelectField from "@/components/ui/SelectField";
import CollectionView from "@/components/collections/CollectionView";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { RESOURCE_ACTION_CATALOG } from "@/lib/actions/resourceActions";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  decodePodcastSubscriptionListItem,
  type PodcastSubscriptionListItem,
} from "./podcastSubscriptions";
import { usePodcastSubscriptionActions } from "./usePodcastSubscriptionActions";
import { usePodcastSubscriptionSettingsModal } from "./usePodcastSubscriptionSettingsModal";
import PodcastSubscriptionSettingsModal from "./PodcastSubscriptionSettingsModal";
import {
  listMemberLibraries,
  type MemberLibrary,
} from "@/lib/libraries/client";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { findPaneSearchFocusTarget } from "@/lib/workspace/paneDom";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneIsActive,
  usePaneReturnReady,
  usePaneRuntime,
  requirePaneRuntime,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import { isAbortError } from "@/lib/errors";
import {
  CANONICAL_PODCAST_SUBSCRIPTION_VIEW,
  SUBSCRIPTION_FILTERS,
  SUBSCRIPTION_SORTS,
  activeSubscriptionControlCount,
  decodePodcastSubscriptionView,
  encodePodcastSubscriptionView,
  podcastSubscriptionViewQuery,
  subscriptionFilterLabel,
  subscriptionSortLabel,
  type DecodedPodcastSubscriptionView,
  type SubscriptionFilter,
  type SubscriptionSort,
} from "@/lib/podcasts/subscriptionView";
import { runPodcastRefresh } from "@/lib/podcasts/refresh";
import type { PodcastRefreshResult } from "@/lib/podcasts/types";
import type { PaneRefreshPublication } from "@/lib/panes/panePublications";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import styles from "./page.module.css";

const PAGE_SIZE = 100;

// Module-level so the published descriptor keeps one identity: the chrome
// republishes whenever an action's icon element changes.
const PODCASTS_ACTIONS: readonly PaneHeaderAction[] = [
  {
    kind: "link",
    id: "Podcasts.Browse",
    label: "Browse",
    icon: <Compass size={16} aria-hidden="true" />,
    href: "/browse?kind=Podcast",
  },
];

type PodcastsLoadOperation = "Subscriptions" | "Libraries" | "Revalidate";

function podcastsLoadErrorMessage(
  error: unknown,
  operation: PodcastsLoadOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  const title =
    operation === "Subscriptions"
      ? "Followed podcasts couldn’t be loaded"
      : operation === "Libraries"
        ? "Podcast libraries couldn’t be loaded"
        : "Podcasts couldn’t be refreshed";
  switch (error.code) {
    case "E_NETWORK":
      return { tone: "Danger", title, message: "Check your connection and retry.", requestId };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "The server took too long to respond. Retry the load.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return { tone: "Danger", title, message: "Wait a moment, then retry.", requestId };
    case "E_BAD_REQUEST":
    case "E_INVALID_REQUEST":
      if (operation !== "Revalidate") throw error;
      return {
        tone: "Danger",
        title,
        message: "The podcast view changed. Refresh the pane, then retry.",
        requestId,
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title,
        message: "This account can’t view those podcasts.",
        requestId,
      };
    case "E_NOT_FOUND":
    case "E_LIBRARY_NOT_FOUND":
      if (operation !== "Libraries") throw error;
      return {
        tone: "Danger",
        title,
        message: "The selected library is no longer available. Clear the library filter.",
        requestId,
      };
    default:
      throw error;
  }
}

function podcastRefreshFeedback(result: PodcastRefreshResult): FeedbackContent | null {
  switch (result.kind) {
    case "Complete":
      return null;
    case "Partial":
      return {
        tone: "Warning",
        title: "Some podcasts couldn’t be refreshed",
        message: "Available episode updates were kept. Check again later for the remaining shows.",
      };
    case "Failed":
      return {
        tone: "Danger",
        title: "Episodes weren’t refreshed",
        message: "No refresh result was committed. Retry when the podcast source is available.",
      };
    case "ObservationLost":
      return {
        tone: "Warning",
        title: "Refresh status couldn’t be confirmed",
        message: "The refresh may still be running. Wait for the list to update before starting another.",
      };
  }
}

interface PodcastsSnapshot {
  readonly subscriptions: readonly PodcastSubscriptionListItem[];
  readonly queryIdentity: string;
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
  readonly exhaustion: "Partial" | "Complete";
  readonly libraries: readonly MemberLibrary[];
}

interface PendingPodcastsRevalidation {
  readonly nonce: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

const PODCASTS_VISIT_DATA =
  definePaneVisitDataKey<PodcastsSnapshot>("Podcasts.Subscriptions");
const EMPTY_SUBSCRIPTIONS: readonly PodcastSubscriptionListItem[] = [];
const EMPTY_MEMBER_LIBRARIES: readonly MemberLibrary[] = [];

export default function PodcastsPaneBody() {
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "PodcastsPaneBody");
  const isPaneActive = usePaneIsActive();
  // The pane URL owns the subscriptions view through a strict, total codec;
  // `view` is null only when the URL is Invalid, which is a terminal,
  // user-recoverable state that requests nothing.
  const subscriptionViewCodec = useMemo(
    () => ({
      basePath: "/podcasts",
      decode: decodePodcastSubscriptionView,
      encode: (
        decoded: DecodedPodcastSubscriptionView,
        current: URLSearchParams,
      ) =>
        encodePodcastSubscriptionView(
          decoded.kind === "Valid"
            ? decoded.view
            : CANONICAL_PODCAST_SUBSCRIPTION_VIEW,
          current,
        ),
      replaceOptions: {
        viewTransition: { kind: "collection-reflow" } as const,
      },
    }),
    [],
  );
  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(subscriptionViewCodec);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  // The request identity is the exact API query the view names.
  const subscriptionQueryIdentity =
    view === null ? null : podcastSubscriptionViewQuery(view).toString();
  const committedSnapshotRef = useRef<PodcastsSnapshot | null>(null);
  const refreshFallbackSnapshotRef = useRef<PodcastsSnapshot | null>(null);
  const captureCommitted = useCallback(
    () => committedSnapshotRef.current,
    [],
  );
  const restored = usePaneVisitData(PODCASTS_VISIT_DATA, captureCommitted);
  const [controller, setController] = useState<PodcastsSnapshot | null>(
    restored,
  );
  const controllerRef = useRef<PodcastsSnapshot | null>(restored);
  const [chainEpoch, setChainEpoch] = useState(0);
  const [initialLoadEnabled, setInitialLoadEnabled] = useState(restored === null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const reloadNonceRef = useRef(0);
  const pendingPodcastsRevalidationRef =
    useRef<PendingPodcastsRevalidation | null>(null);
  const completedPodcastsRevalidationNonceRef = useRef<number | null>(null);
  const clearAllVisitData = useClearAllPaneVisitData();
  const initialPageRef = useRef<
    CollectionPage<PodcastSubscriptionListItem> | null
  >(null);
  const initialPageNonceRef = useRef(0);
  const initialLibrariesRef = useRef<readonly MemberLibrary[] | null>(
    restored?.libraries ?? null,
  );
  const allowInitialAdoptionRef = useRef(restored === null);
  const rejectPendingPodcastsRevalidation = useCallback((error: unknown) => {
    const pending = pendingPodcastsRevalidationRef.current;
    pendingPodcastsRevalidationRef.current = null;
    completedPodcastsRevalidationNonceRef.current = null;
    if (!pending) return;
    pending.removeAbortListener();
    pending.reject(error);
  }, []);
  // Abandons the committed chain so the next first page is adopted afresh. A
  // view change needs only this: the view is already part of the request
  // identity.
  const resetSubscriptionChain = useCallback(() => {
    rejectPendingPodcastsRevalidation(
      new DOMException("Podcasts refresh was superseded.", "AbortError"),
    );
    if (committedSnapshotRef.current !== null) {
      refreshFallbackSnapshotRef.current = committedSnapshotRef.current;
    }
    committedSnapshotRef.current = null;
    clearAllVisitData();
    allowInitialAdoptionRef.current = true;
    initialPageRef.current = null;
    setInitialLoadEnabled(true);
  }, [clearAllVisitData, rejectPendingPodcastsRevalidation]);
  // A refresh keeps the view, so only a fresh nonce makes the request identity
  // differ from the one already loaded.
  const refreshSubscriptions = useCallback(() => {
    resetSubscriptionChain();
    const nonce = reloadNonceRef.current + 1;
    reloadNonceRef.current = nonce;
    setReloadNonce(nonce);
  }, [resetSubscriptionChain]);
  const revalidateSubscriptions = useCallback(
    (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ??
            new DOMException("Podcasts refresh was aborted.", "AbortError"),
        );
      }
      refreshSubscriptions();
      const nonce = reloadNonceRef.current;
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const pending = pendingPodcastsRevalidationRef.current;
          if (pending?.nonce !== nonce) return;
          pendingPodcastsRevalidationRef.current = null;
          completedPodcastsRevalidationNonceRef.current = null;
          pending.removeAbortListener();
          allowInitialAdoptionRef.current = false;
          setInitialLoadEnabled(false);
          committedSnapshotRef.current = refreshFallbackSnapshotRef.current;
          refreshFallbackSnapshotRef.current = null;
          reject(
            signal.reason ??
              new DOMException("Podcasts refresh was aborted.", "AbortError"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pendingPodcastsRevalidationRef.current = {
          nonce,
          resolve,
          reject,
          removeAbortListener: () =>
            signal.removeEventListener("abort", onAbort),
        };
        if (signal.aborted) onAbort();
      });
    },
    [refreshSubscriptions],
  );
  useEffect(
    () => () => {
      rejectPendingPodcastsRevalidation(
        new DOMException("Podcasts refresh source was replaced.", "AbortError"),
      );
    },
    [rejectPendingPodcastsRevalidation, subscriptionQueryIdentity],
  );
  const commitInitialController = useCallback(() => {
    if (
      !allowInitialAdoptionRef.current ||
      subscriptionQueryIdentity === null ||
      initialPageRef.current === null ||
      initialLibrariesRef.current === null
    ) {
      return;
    }
    allowInitialAdoptionRef.current = false;
    const page = initialPageRef.current;
    const snapshot: PodcastsSnapshot = {
      subscriptions: page.items,
      queryIdentity: subscriptionQueryIdentity,
      collectionRevision: page.collectionRevision,
      nextCursor: page.nextCursor,
      exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      libraries: initialLibrariesRef.current,
    };
    controllerRef.current = snapshot;
    committedSnapshotRef.current = snapshot;
    refreshFallbackSnapshotRef.current = null;
    setController(snapshot);
    setChainEpoch((epoch) => epoch + 1);
    const pending = pendingPodcastsRevalidationRef.current;
    if (pending?.nonce === initialPageNonceRef.current) {
      completedPodcastsRevalidationNonceRef.current = pending.nonce;
    }
  }, [subscriptionQueryIdentity]);
  const setRows = useCallback(
    (update: SetStateAction<PodcastSubscriptionListItem[]>) => {
      setController((current) => {
        if (current === null) return current;
        const previous = [...current.subscriptions];
        const subscriptions =
          typeof update === "function" ? update(previous) : update;
        const next = { ...current, subscriptions };
        controllerRef.current = next;
        return next;
      });
    },
    [],
  );
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const captureLoadError = useCallback(
    (loadError: unknown, operation: PodcastsLoadOperation) => {
      try {
        setError(podcastsLoadErrorMessage(loadError, operation));
      } catch (defect) {
        setAsyncDefect({ error: defect });
      }
    },
    [],
  );
  const actions = usePodcastSubscriptionActions(setError);
  const rowRefreshOwnerRef = useRef<{
    readonly sourceKey: string;
    readonly controller: AbortController;
  } | null>(null);
  useEffect(() => {
    if (subscriptionQueryIdentity === null) return;
    const owner = {
      sourceKey: subscriptionQueryIdentity,
      controller: new AbortController(),
    };
    rowRefreshOwnerRef.current = owner;
    return () => {
      owner.controller.abort(
        new DOMException("Podcasts view was replaced.", "AbortError"),
      );
      if (rowRefreshOwnerRef.current === owner) {
        rowRefreshOwnerRef.current = null;
      }
    };
  }, [subscriptionQueryIdentity]);
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusNeighborRef = useRef<string | null | undefined>(undefined);
  const pendingFocusRafRef = useRef(0);
  const captureFocusNeighbor = useCallback((removedId: string) => {
    const region = listRegionRef.current;
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
  const previousSubscriptionQueryIdentityRef = useRef(
    subscriptionQueryIdentity,
  );
  const [librariesLoading, setLibrariesLoading] = useState(restored === null);
  const settingsModal = usePodcastSubscriptionSettingsModal({
    onSaved: (response) => {
      setRows((prev) =>
        prev.map((row) =>
          row.podcast_id === response.podcast_id
            ? {
                ...row,
                default_playback_speed: response.default_playback_speed,
                pause_shortening_mode: response.pause_shortening_mode,
                auto_queue: response.auto_queue,
              }
            : row,
          ),
      );
      refreshSubscriptions();
    },
  });

  const rows = controller?.subscriptions ?? EMPTY_SUBSCRIPTIONS;
  const libraries = controller?.libraries ?? EMPTY_MEMBER_LIBRARIES;
  const loading = controller === null && error === null;

  useLayoutEffect(() => {
    if (
      previousSubscriptionQueryIdentityRef.current ===
      subscriptionQueryIdentity
    ) {
      return;
    }
    previousSubscriptionQueryIdentityRef.current = subscriptionQueryIdentity;
    resetSubscriptionChain();
  }, [resetSubscriptionChain, subscriptionQueryIdentity]);

  const subscriptionListResource = useResource<
    CollectionPage<PodcastSubscriptionListItem>
  >({
    cacheKey:
      view !== null && initialLoadEnabled
        ? ["podcast-subscriptions", subscriptionQueryIdentity, reloadNonce].join(
            ":",
          )
        : null,
    load: async (signal) => {
      if (view === null) {
        throw new Error("Podcast subscriptions require an addressable view");
      }
      const params = podcastSubscriptionViewQuery(view);
      params.set("limit", String(PAGE_SIZE));
      const response = await apiFetch<unknown>(
        `/api/podcasts/subscriptions?${params.toString()}`,
        { signal },
      );
      return decodeCollectionPage(response, decodePodcastSubscriptionListItem);
    },
  });

  useEffect(() => {
    if (subscriptionListResource.status === "loading") {
      setError(null);
      return;
    }

    if (subscriptionListResource.status === "ready") {
      initialPageRef.current = subscriptionListResource.data;
      initialPageNonceRef.current = reloadNonce;
      commitInitialController();
      setError(null);
      return;
    }

    if (subscriptionListResource.status === "error") {
      allowInitialAdoptionRef.current = false;
      setInitialLoadEnabled(false);
      committedSnapshotRef.current = refreshFallbackSnapshotRef.current;
      refreshFallbackSnapshotRef.current = null;
      const pending = pendingPodcastsRevalidationRef.current;
      captureLoadError(
        subscriptionListResource.error,
        pending?.nonce === reloadNonce ? "Revalidate" : "Subscriptions",
      );
      if (pending?.nonce === reloadNonce) {
        rejectPendingPodcastsRevalidation(subscriptionListResource.error);
      }
    }
  }, [
    commitInitialController,
    captureLoadError,
    rejectPendingPodcastsRevalidation,
    reloadNonce,
    subscriptionListResource,
  ]);

  useEffect(() => {
    if (restored !== null || view === null) return;
    let cancelled = false;
    setLibrariesLoading(true);
    void listMemberLibraries({ limit: 200 })
      .then((data) => {
        if (!cancelled) {
          initialLibrariesRef.current = data;
          commitInitialController();
        }
      })
      .catch((err) => {
        if (handleUnauthenticatedApiError(err)) return;
        if (!cancelled) {
          captureLoadError(err, "Libraries");
        }
      })
      .finally(() => {
        if (!cancelled) setLibrariesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [captureLoadError, commitInitialController, restored, view]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = controller;
    controllerRef.current = controller;
    const pending = pendingPodcastsRevalidationRef.current;
    if (
      controller === null ||
      pending === null ||
      completedPodcastsRevalidationNonceRef.current !== pending.nonce ||
      controller.queryIdentity !== subscriptionQueryIdentity
    ) {
      return;
    }
    completedPodcastsRevalidationNonceRef.current = null;
    pendingPodcastsRevalidationRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, [controller, subscriptionQueryIdentity]);

  usePaneReturnReady(controller !== null || error !== null);

  const loadSubscriptionPage = useCallback(
    async (
      cursor: CollectionCursor,
      revision: CollectionRevision,
      signal: AbortSignal,
    ) => {
      if (view === null) {
        throw new Error("Podcast subscriptions require an addressable view");
      }
      const params = podcastSubscriptionViewQuery(view);
      params.set("limit", String(PAGE_SIZE));
      params.set("cursor", cursor);
      params.set("collection_revision", String(revision));
      const response = await apiFetch<unknown>(
        `/api/podcasts/subscriptions?${params.toString()}`,
        { signal },
      );
      return decodeCollectionPage(response, decodePodcastSubscriptionListItem);
    },
    [view],
  );
  const commitSubscriptionPage = useCallback(
    (page: CollectionPage<PodcastSubscriptionListItem>) => {
      const current = controllerRef.current;
      if (
        current === null ||
        page.collectionRevision !== current.collectionRevision
      ) {
        throw new Error("Podcast subscription continuation revision mismatch");
      }
      const seen = new Set(current.subscriptions.map((row) => row.podcast_id));
      const subscriptions = [...current.subscriptions];
      for (const row of page.items) {
        if (seen.has(row.podcast_id)) continue;
        seen.add(row.podcast_id);
        subscriptions.push(row);
      }
      const next: PodcastsSnapshot = {
        ...current,
        subscriptions,
        nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      controllerRef.current = next;
      setController(next);
      return subscriptions.length;
    },
    [],
  );
  const exhaustion = useExhaustivePagination({
    active:
      isPaneActive &&
      controller !== null &&
      controller.queryIdentity === subscriptionQueryIdentity &&
      !allowInitialAdoptionRef.current,
    chainKey: [subscriptionQueryIdentity, chainEpoch].join(":"),
    cursor: controller?.nextCursor ?? { kind: "Absent" },
    collectionRevision:
      controller?.collectionRevision ?? (0 as CollectionRevision),
    itemCount: rows.length,
    loadPage: loadSubscriptionPage,
    commitPage: commitSubscriptionPage,
    refresh: refreshSubscriptions,
  });

  const unsubscribePodcast = useCallback(
    (row: PodcastSubscriptionListItem) => {
      return actions.unsubscribe(
        row.podcast_id,
        row.title,
        (_libraries, result) => {
          captureFocusNeighbor(row.podcast_id);
          setController((current) => {
            if (current === null) return current;
            const next = {
              ...current,
              subscriptions: current.subscriptions.filter(
                (candidate) => candidate.podcast_id !== row.podcast_id,
              ),
              collectionRevision: result.collectionRevision,
            };
            controllerRef.current = next;
            return next;
          });
          setChainEpoch((epoch) => epoch + 1);
          clearAllVisitData();
        },
      );
    },
    [actions, captureFocusNeighbor, clearAllVisitData],
  );

  const checkForNewEpisodes = useCallback(
    (podcastId: string) => {
      const owner = rowRefreshOwnerRef.current;
      if (owner?.sourceKey !== subscriptionQueryIdentity) {
        return Promise.resolve();
      }
      return actions.checkForNewEpisodes(
        podcastId,
        owner.controller.signal,
        async (result, signal) => {
          try {
            await revalidateSubscriptions(signal);
            setError(podcastRefreshFeedback(result));
          } catch (refreshError: unknown) {
            if (isAbortError(refreshError)) throw refreshError;
            if (handleUnauthenticatedApiError(refreshError)) return;
            captureLoadError(refreshError, "Revalidate");
          }
        },
      );
    },
    [actions, captureLoadError, revalidateSubscriptions, subscriptionQueryIdentity],
  );

  const finalCount =
    !loading && exhaustion.kind === "Complete"
      ? exhaustion.itemCount
      : null;
  const settingsRow =
    settingsModal.podcastId !== null
      ? (rows.find((row) => row.podcast_id === settingsModal.podcastId) ?? null)
      : null;
  const activeDomainControlCount =
    view === null ? 0 : activeSubscriptionControlCount(view);
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
    setDecodedView({
      kind: "Valid",
      view: CANONICAL_PODCAST_SUBSCRIPTION_VIEW,
    });
  }, [setDecodedView]);
  const subscriptionFilterNodes = useMemo(
    () =>
      view === null ? undefined : (
        <>
          <SelectField
            layout="Stacked"
            label="Filter"
            value={view.filter}
            onChange={(event) =>
              setDecodedView({
                kind: "Valid",
                view: {
                  ...view,
                  filter: event.target.value as SubscriptionFilter,
                },
              })
            }
          >
            {SUBSCRIPTION_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {subscriptionFilterLabel(filter)}
              </option>
            ))}
          </SelectField>

          <SelectField
            layout="Stacked"
            label="Library"
            value={
              view.library.kind === "ExactLibrary" ? view.library.id : ""
            }
            onChange={(event) =>
              setDecodedView({
                kind: "Valid",
                view: {
                  ...view,
                  library:
                    event.target.value === ""
                      ? { kind: "AllLibraries" }
                      : { kind: "ExactLibrary", id: event.target.value },
                },
              })
            }
            disabled={librariesLoading}
          >
            <option value="">All libraries</option>
            {libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.name}
              </option>
            ))}
          </SelectField>

          <SelectField
            layout="Stacked"
            label="Sort by"
            ref={sortSelectRef}
            value={view.sort}
            onChange={(event) =>
              setDecodedView({
                kind: "Valid",
                view: {
                  ...view,
                  sort: event.target.value as SubscriptionSort,
                },
              })
            }
          >
            {SUBSCRIPTION_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {subscriptionSortLabel(sort)}
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
    [
      activeDomainControlCount,
      libraries,
      librariesLoading,
      resetToCanonicalView,
      setDecodedView,
      view,
    ],
  );
  const getSubscriptionRowStatus = useCallback(
    (query: string) => {
      const visibleCount = rows.filter((row) =>
        matchesPaneFilterQuery(query, [
          row.title,
          ...row.contributors.flatMap((credit) => [
            credit.contributor_display_name ?? "",
            credit.credited_name,
          ]),
        ]),
      ).length;
      return exhaustion.kind === "Complete"
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: rows.length,
            unit: { singular: "show", plural: "shows" },
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: rows.length,
            unit: { singular: "show", plural: "shows" },
          };
    },
    [exhaustion.kind, rows],
  );
  const subscriptionFilterRows = usePaneFilterRows({
    sourceKey: "Podcasts.Subscriptions",
    inputLabel: "Filter followed podcasts",
    placeholder: "Filter shows",
    getRowStatus: getSubscriptionRowStatus,
    activeDomainControlCount,
    filters: subscriptionFilterNodes,
  });
  dismissFilterRowsRef.current = subscriptionFilterRows.publication.onDismiss;
  const visibleRows = useMemo(
    () =>
      rows.filter((row) =>
        matchesPaneFilterQuery(subscriptionFilterRows.query, [
          row.title,
          ...row.contributors.flatMap((credit) => [
            credit.contributor_display_name ?? "",
            credit.credited_name,
          ]),
        ]),
      ),
    [rows, subscriptionFilterRows.query],
  );
  const initialFilterNoMatch =
    loading &&
    subscriptionFilterRows.query.trim().length > 0 &&
    visibleRows.length === 0;
  const visibleRowSignature = visibleRows
    .map((row) => row.podcast_id)
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
          : listRegionRef.current?.querySelector<HTMLElement>(
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
  }, [paneRuntime.paneId, visibleRowSignature]);

  const executeRefresh = useCallback<PaneRefreshPublication["execute"]>(
    async ({ signal, reportProgress }) => {
      try {
        const result = await runPodcastRefresh(
          { kind: "Podcasts" },
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
        await revalidateSubscriptions(signal);
        return {
          kind: result.kind,
          announcement: result.announcement,
        };
      } catch (refreshError: unknown) {
        if (isAbortError(refreshError)) throw refreshError;
        if (!handleUnauthenticatedApiError(refreshError)) {
          try {
            podcastsLoadErrorMessage(refreshError, "Revalidate");
          } catch (defect) {
            setAsyncDefect({ error: defect });
          }
        }
        return {
          kind: "Failed",
          announcement: "Podcasts failed to refresh",
        };
      }
    },
    [revalidateSubscriptions],
  );
  usePanePrimaryChrome({
    header: {
      kind: "Section",
      meta:
        finalCount === null || loading || exhaustion.kind !== "Complete"
          ? { kind: "Pending" }
          : { kind: "Count", value: finalCount, unit: "show" },
    },
    actions: PODCASTS_ACTIONS,
    menu: {
      kind: "FlatMenu",
      actions: [
        {
          kind: "link",
          id: "Podcasts.ExportOpml",
          label: "Export OPML",
          href: "/api/podcasts/export/opml",
        },
      ],
    },
    search: subscriptionFilterRows.publication,
    refresh: {
      sourceKey: `Podcasts.Subscriptions:${subscriptionQueryIdentity}`,
      execute: executeRefresh,
    },
  });

  if (asyncDefect !== null) throw asyncDefect.error;

  if (view === null) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid podcasts view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: resetToCanonicalView }]}
      />
    );
  }

  const collectionRows = visibleRows.map((row) => {
    const rowBusy = actions.unsubscribingPodcastIds.ids.has(row.podcast_id);
    const rowRefreshing = actions.refreshingPodcastIds.ids.has(row.podcast_id);
    return presentPodcast(
      {
        id: row.podcast_id,
        title: row.title,
        contributors: row.contributors,
        unplayedCount: row.unplayedCount,
        publicationDate: row.publicationDate,
        syncStatus: row.syncStatus,
      },
      {
        settings: {
          kind: "Available",
          execute: () =>
            settingsModal.open({
              podcast_id: row.podcast_id,
              default_playback_speed: row.default_playback_speed,
              pause_shortening_mode: row.pause_shortening_mode,
              auto_queue: row.auto_queue,
            }),
        },
        checkForNewEpisodes: {
          kind: "Available",
          execute: async () => {
            if (actions.refreshingPodcastIds.has(row.podcast_id)) return;
            await checkForNewEpisodes(row.podcast_id);
          },
        },
        subscription: {
          kind: "Subscribed",
          execute: async () => {
            if (actions.unsubscribingPodcastIds.has(row.podcast_id)) return;
            await unsubscribePodcast(row);
          },
        },
        busyIds: new Set([
          ...(rowRefreshing
            ? [RESOURCE_ACTION_CATALOG.RefreshPodcast.id]
            : []),
          ...(rowBusy
            ? [RESOURCE_ACTION_CATALOG.UnsubscribePodcast.id]
            : []),
        ]),
      },
    );
  });

  return (
    <>
      <div ref={listRegionRef} style={{ display: "contents" }}>
        <CollectionView
          returnScope="Podcasts.Subscriptions"
          rows={collectionRows}
          status={loading ? "loading" : "ready"}
          ariaLabel="Followed podcasts"
          rowChangePresentation={{
            kind: "ImmediateOnKeyChange",
            key: subscriptionFilterRows.query.trim(),
          }}
          notice={
            error ? (
              <FeedbackNotice content={error} announcement="Assertive" />
            ) : initialFilterNoMatch ? (
              <FeedbackNotice
                content={{ tone: "Neutral", title: "No matching show found so far." }}
                announcement="None"
              />
            ) : undefined
          }
          empty={
            subscriptionFilterRows.query.trim() ? (
              <FeedbackNotice
                content={{
                  tone: "Neutral",
                  title:
                    exhaustion.kind === "Complete"
                      ? "No shows match this filter."
                      : "No matching show found so far.",
                }}
                announcement="None"
              />
            ) : activeDomainControlCount > 0 ? (
              <FeedbackNotice
                content={{
                  tone: "Neutral",
                  title: "No podcasts match the current filters.",
                }}
                announcement="None"
              >
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.inlineButton}
                    onClick={resetToCanonicalView}
                  >
                    Clear filters
                  </Button>
              </FeedbackNotice>
            ) : (
              <FeedbackNotice
                content={{ tone: "Neutral", title: "No followed podcasts yet." }}
                announcement="None"
              >
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className={styles.inlineButton}
                  >
                    <Link href="/browse?kind=Podcast">
                      Browse podcasts
                    </Link>
                  </Button>
              </FeedbackNotice>
            )
          }
          collectionBusy={exhaustion.kind === "Draining"}
          footer={<CollectionExhaustionNotice state={exhaustion} />}
        />
      </div>

      <PodcastSubscriptionSettingsModal
        podcastTitle={settingsRow?.title ?? null}
        settingsModal={settingsModal}
      />
    </>
  );
}
