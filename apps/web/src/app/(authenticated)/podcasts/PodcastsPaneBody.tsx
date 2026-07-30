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
import { apiFetch } from "@/lib/api/client";
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
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import CollectionView from "@/components/collections/CollectionView";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { RESOURCE_ACTION_CATALOG } from "@/lib/actions/resourceActions";
import {
  FeedbackNotice,
  toFeedback,
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
import { requestNexusOpen } from "@/lib/nexus/events";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { findPaneSearchFocusTarget } from "@/lib/workspace/paneDom";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneReturnReady,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  requirePaneRuntime,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

const PAGE_SIZE = 100;

type SubscriptionSort = "recent_episode" | "unplayed_count" | "alpha";
type SubscriptionFilter = "all" | "has_new" | "not_in_library";

interface PodcastListUrlState {
  sort: SubscriptionSort;
  filter: SubscriptionFilter;
  libraryId: string;
}

const DEFAULT_PODCAST_LIST_STATE: PodcastListUrlState = {
  sort: "recent_episode",
  filter: "all",
  libraryId: "",
};

interface PodcastsSnapshot {
  readonly subscriptions: readonly PodcastSubscriptionListItem[];
  readonly queryIdentity: string;
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
  readonly exhaustion: "Partial" | "Complete";
  readonly libraries: readonly MemberLibrary[];
}

const PODCASTS_VISIT_DATA =
  definePaneVisitDataKey<PodcastsSnapshot>("Podcasts.Subscriptions");
const EMPTY_SUBSCRIPTIONS: readonly PodcastSubscriptionListItem[] = [];
const EMPTY_MEMBER_LIBRARIES: readonly MemberLibrary[] = [];

function decodePodcastListState(params: URLSearchParams): PodcastListUrlState {
  const rawSort = params.get("sort");
  const rawFilter = params.get("filter");
  return {
    sort:
      rawSort === "unplayed_count" || rawSort === "alpha"
        ? rawSort
        : DEFAULT_PODCAST_LIST_STATE.sort,
    filter:
      rawFilter === "has_new" || rawFilter === "not_in_library"
        ? rawFilter
        : DEFAULT_PODCAST_LIST_STATE.filter,
    libraryId: params.get("library_id")?.trim() ?? "",
  };
}

function encodePodcastListState(
  state: PodcastListUrlState,
): URLSearchParams {
  const next = new URLSearchParams();
  if (state.sort === DEFAULT_PODCAST_LIST_STATE.sort) {
    next.delete("sort");
  } else {
    next.set("sort", state.sort);
  }
  if (state.filter === DEFAULT_PODCAST_LIST_STATE.filter) {
    next.delete("filter");
  } else {
    next.set("filter", state.filter);
  }
  if (state.libraryId) {
    next.set("library_id", state.libraryId);
  } else {
    next.delete("library_id");
  }
  return next;
}

export default function PodcastsPaneBody() {
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "PodcastsPaneBody");
  const paneRouter = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();
  const podcastListCodec = useMemo(
    () => ({
      basePath: "/podcasts",
      decode: decodePodcastListState,
      encode: encodePodcastListState,
      replaceOptions: {
        viewTransition: { kind: "collection-reflow" } as const,
      },
    }),
    [],
  );
  const { state: podcastListState, setState: setPodcastListState } =
    usePaneUrlState(podcastListCodec);
  const canonicalPodcastListSearch =
    encodePodcastListState(podcastListState).toString();
  useEffect(() => {
    if (paneSearchParams.toString() === canonicalPodcastListSearch) return;
    paneRouter.replace(
      canonicalPodcastListSearch
        ? `/podcasts?${canonicalPodcastListSearch}`
        : "/podcasts",
    );
  }, [canonicalPodcastListSearch, paneRouter, paneSearchParams]);
  const subscriptionSort = podcastListState.sort;
  const subscriptionFilter = podcastListState.filter;
  const selectedLibraryId = podcastListState.libraryId;
  const subscriptionQueryIdentity = [
    subscriptionSort,
    subscriptionFilter,
    selectedLibraryId,
  ].join("\u0000");
  const committedSnapshotRef = useRef<PodcastsSnapshot | null>(null);
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
  const clearAllVisitData = useClearAllPaneVisitData();
  const initialPageRef = useRef<
    CollectionPage<PodcastSubscriptionListItem> | null
  >(null);
  const initialLibrariesRef = useRef<readonly MemberLibrary[] | null>(
    restored?.libraries ?? null,
  );
  const allowInitialAdoptionRef = useRef(restored === null);
  const refreshSubscriptions = useCallback(() => {
    committedSnapshotRef.current = null;
    clearAllVisitData();
    allowInitialAdoptionRef.current = true;
    initialPageRef.current = null;
    setInitialLoadEnabled(true);
    setReloadNonce((nonce) => nonce + 1);
  }, [clearAllVisitData]);
  const commitInitialController = useCallback(() => {
    if (
      !allowInitialAdoptionRef.current ||
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
    setController(snapshot);
    setChainEpoch((epoch) => epoch + 1);
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
  const actions = usePodcastSubscriptionActions(setError);
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
                default_playback_speed:
                  response.default_playback_speed === null
                    ? { kind: "Absent" as const }
                    : {
                        kind: "Present" as const,
                        value: response.default_playback_speed,
                      },
                defaultPlaybackSpeed: response.default_playback_speed,
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
    refreshSubscriptions();
  }, [refreshSubscriptions, subscriptionQueryIdentity]);

  const subscriptionListResource = useResource<
    CollectionPage<PodcastSubscriptionListItem>
  >({
    cacheKey:
      initialLoadEnabled
        ? [
            "podcast-subscriptions",
            subscriptionSort,
            subscriptionFilter,
            selectedLibraryId,
            reloadNonce,
          ].join(":")
        : null,
    load: async (signal) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        sort: subscriptionSort,
        filter: subscriptionFilter,
      });
      if (selectedLibraryId) {
        params.set("library_id", selectedLibraryId);
      }
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
      commitInitialController();
      setError(null);
      return;
    }

    if (subscriptionListResource.status === "error") {
      setError(
        toFeedback(subscriptionListResource.error, {
          fallback: "Failed to load followed podcasts",
        }),
      );
    }
  }, [commitInitialController, subscriptionListResource]);

  useEffect(() => {
    if (restored !== null) return;
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
          setError(toFeedback(err, { fallback: "Failed to load libraries" }));
        }
      })
      .finally(() => {
        if (!cancelled) setLibrariesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [commitInitialController, restored]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = controller;
    controllerRef.current = controller;
  }, [controller]);

  usePaneReturnReady(controller !== null || error !== null);

  const loadSubscriptionPage = useCallback(
    async (
      cursor: CollectionCursor,
      revision: CollectionRevision,
      signal: AbortSignal,
    ) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        sort: subscriptionSort,
        filter: subscriptionFilter,
        cursor,
        collection_revision: String(revision),
      });
      if (selectedLibraryId) {
        params.set("library_id", selectedLibraryId);
      }
      const response = await apiFetch<unknown>(
        `/api/podcasts/subscriptions?${params.toString()}`,
        { signal },
      );
      return decodeCollectionPage(response, decodePodcastSubscriptionListItem);
    },
    [
      selectedLibraryId,
      subscriptionFilter,
      subscriptionSort,
    ],
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
      paneRuntime.isActive &&
      controller !== null &&
      controller.queryIdentity === subscriptionQueryIdentity &&
      !allowInitialAdoptionRef.current,
    chainKey: [
      subscriptionSort,
      subscriptionFilter,
      selectedLibraryId,
      chainEpoch,
    ].join(":"),
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

  const refreshPodcastSync = useCallback(
    (podcastId: string) =>
      actions.refreshSync(podcastId, (patch) => {
        setRows((prev) =>
          prev.map((row) =>
            row.podcast_id === podcastId ? { ...row, ...patch } : row,
          ),
        );
        refreshSubscriptions();
      }),
    [actions, refreshSubscriptions, setRows],
  );

  const finalCount =
    !loading && exhaustion.kind === "Complete"
      ? exhaustion.itemCount
      : null;
  const settingsRow =
    settingsModal.podcastId !== null
      ? (rows.find((row) => row.podcast_id === settingsModal.podcastId) ?? null)
      : null;
  const hasActiveDomainFilters =
    subscriptionFilter !== "all" ||
    selectedLibraryId.length > 0 ||
    subscriptionSort !== DEFAULT_PODCAST_LIST_STATE.sort;
  const dismissFilterRowsRef = useRef<() => void>(() => undefined);
  const clearFilters = useCallback(() => {
    dismissFilterRowsRef.current();
    setPodcastListState({
      ...podcastListState,
      sort: DEFAULT_PODCAST_LIST_STATE.sort,
      filter: "all",
      libraryId: "",
    });
  }, [podcastListState, setPodcastListState]);
  const subscriptionFilterNodes = useMemo(
    () => (
      <>
        <label className={styles.selectField}>
          <span>Filter</span>
          <Select
            value={subscriptionFilter}
            onChange={(event) =>
              setPodcastListState({
                ...podcastListState,
                filter: event.target.value as SubscriptionFilter,
              })
            }
          >
            <option value="all">All</option>
            <option value="has_new">Has New</option>
            <option value="not_in_library">Not In Library</option>
          </Select>
        </label>

        <label className={styles.selectField}>
          <span>Library</span>
          <Select
            value={selectedLibraryId}
            onChange={(event) =>
              setPodcastListState({
                ...podcastListState,
                libraryId: event.target.value,
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
          </Select>
        </label>

        <label className={styles.selectField}>
          <span>Sort</span>
          <Select
            value={subscriptionSort}
            onChange={(event) =>
              setPodcastListState({
                ...podcastListState,
                sort: event.target.value as SubscriptionSort,
              })
            }
          >
            <option value="recent_episode">Recent Episode</option>
            <option value="unplayed_count">Most Unplayed</option>
            <option value="alpha">A-Z</option>
          </Select>
        </label>
      </>
    ),
    [
      libraries,
      librariesLoading,
      podcastListState,
      selectedLibraryId,
      setPodcastListState,
      subscriptionFilter,
      subscriptionSort,
    ],
  );
  const subscriptionControlNodes = useMemo(
    () => (
      <>
        {hasActiveDomainFilters ? (
          <Button variant="secondary" size="md" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </>
    ),
    [clearFilters, hasActiveDomainFilters],
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
    activeDomainControlCount:
      Number(subscriptionFilter !== "all") +
      Number(selectedLibraryId.length > 0) +
      Number(subscriptionSort !== DEFAULT_PODCAST_LIST_STATE.sort),
    filters: subscriptionFilterNodes,
    controls: subscriptionControlNodes,
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

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio:
        finalCount === null
          ? { kind: "none" }
          : { kind: "count", value: finalCount, unit: "show" },
      pending: loading || exhaustion.kind !== "Complete",
    },
    search: subscriptionFilterRows.publication,
  });

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
              default_playback_speed: row.defaultPlaybackSpeed,
              auto_queue: row.auto_queue,
            }),
        },
        refreshSync: {
          kind: "Available",
          execute: async () => {
            if (actions.refreshingPodcastIds.has(row.podcast_id)) return;
            await refreshPodcastSync(row.podcast_id);
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
          opener={
            <SectionOpener
              heading="Podcasts"
              actions={
                <>
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() =>
                      requestNexusOpen({
                        kind: "QuickAction",
                        actionId: "Nexus.Quick.Podcast",
                      })
                    }
                  >
                    Browse
                  </Button>
                  <ActionMenu
                    label="Podcast page actions"
                    options={[
                      {
                        kind: "link",
                        id: "export-opml",
                        label: "Export OPML",
                        href: "/api/podcasts/export/opml",
                      },
                    ]}
                  />
                </>
              }
            />
          }
          rowChangePresentation={{
            kind: "ImmediateOnKeyChange",
            key: subscriptionFilterRows.query.trim(),
          }}
          notice={
            error ? (
              <FeedbackNotice feedback={error} />
            ) : initialFilterNoMatch ? (
              <FeedbackNotice severity="neutral">
                No matching show found so far.
              </FeedbackNotice>
            ) : undefined
          }
          empty={
            <FeedbackNotice severity="neutral">
              {subscriptionFilterRows.query.trim() ? (
                exhaustion.kind === "Complete" ? (
                  "No shows match this filter."
                ) : (
                  "No matching show found so far."
                )
              ) : hasActiveDomainFilters ? (
                <>
                  No podcasts match the current filters.{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.inlineButton}
                    onClick={clearFilters}
                  >
                    Clear filters
                  </Button>
                </>
              ) : (
                <>
                  No followed podcasts yet.{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.inlineButton}
                    onClick={() =>
                      requestNexusOpen({
                        kind: "QuickAction",
                        actionId: "Nexus.Quick.Podcast",
                      })
                    }
                  >
                    Browse podcasts
                  </Button>
                </>
              )}
            </FeedbackNotice>
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
