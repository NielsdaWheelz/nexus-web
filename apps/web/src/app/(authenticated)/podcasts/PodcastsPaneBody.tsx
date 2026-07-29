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
import { pluralize } from "@/lib/text/pluralize";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import PaneToolbar from "@/components/ui/PaneToolbar";
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
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneReturnReady,
  usePaneRuntime,
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
  query: string;
  libraryId: string;
}

const DEFAULT_PODCAST_LIST_STATE: PodcastListUrlState = {
  sort: "recent_episode",
  filter: "all",
  query: "",
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
    query: params.get("q")?.trim() ?? "",
    libraryId: params.get("library_id")?.trim() ?? "",
  };
}

function encodePodcastListState(
  state: PodcastListUrlState,
  currentParams: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(currentParams);
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
  const query = state.query.trim();
  if (query) {
    next.set("q", query);
  } else {
    next.delete("q");
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
  const subscriptionSort = podcastListState.sort;
  const subscriptionFilter = podcastListState.filter;
  const appliedSearch = podcastListState.query;
  const selectedLibraryId = podcastListState.libraryId;
  const subscriptionQueryIdentity = [
    subscriptionSort,
    subscriptionFilter,
    selectedLibraryId,
    appliedSearch,
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
  const previousSubscriptionQueryIdentityRef = useRef(
    subscriptionQueryIdentity,
  );
  const [searchText, setSearchText] = useState(appliedSearch);
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

  const rows = controller?.subscriptions ?? [];
  const libraries = controller?.libraries ?? EMPTY_MEMBER_LIBRARIES;
  const loading = controller === null && error === null;

  useEffect(() => {
    setSearchText(appliedSearch);
  }, [appliedSearch]);

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
            appliedSearch,
            reloadNonce,
          ].join(":")
        : null,
    load: async (signal) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        sort: subscriptionSort,
        filter: subscriptionFilter,
      });
      if (appliedSearch) {
        params.set("q", appliedSearch);
      }
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
      if (appliedSearch) {
        params.set("q", appliedSearch);
      }
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
      appliedSearch,
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
      appliedSearch,
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
    (row: PodcastSubscriptionListItem) =>
      actions.unsubscribe(row.podcast_id, row.title, (_libraries, result) => {
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
      }),
    [actions, clearAllVisitData],
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
  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio:
        finalCount === null
          ? { kind: "none" }
          : { kind: "count", value: finalCount, unit: "show" },
      pending: loading || exhaustion.kind === "Draining",
    },
  });
  const settingsRow =
    settingsModal.podcastId !== null
      ? (rows.find((row) => row.podcast_id === settingsModal.podcastId) ?? null)
      : null;
  const hasActiveFilters =
    appliedSearch.length > 0 ||
    subscriptionFilter !== "all" ||
    selectedLibraryId.length > 0;
  const clearFilters = () => {
    setSearchText("");
    setPodcastListState({
      ...podcastListState,
      filter: "all",
      query: "",
      libraryId: "",
    });
  };

  const collectionRows = rows.map((row) => {
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
      <CollectionView
        returnScope="Podcasts.Subscriptions"
        rows={collectionRows}
        status={loading ? "loading" : "ready"}
        ariaLabel="Followed podcasts"
        opener={<SectionOpener heading="Podcasts" />}
        toolbar={
          <PaneToolbar
            search={
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setPodcastListState({
                    ...podcastListState,
                    query: searchText.trim(),
                  });
                }}
                style={{ display: "flex", gap: "var(--space-2)" }}
              >
                <Input
                  type="search"
                  value={searchText}
                  placeholder="Search followed podcasts..."
                  onChange={(event) => setSearchText(event.target.value)}
                  style={{ flex: 1 }}
                />
                <Button type="submit" variant="primary" size="md">
                  Search
                </Button>
              </form>
            }
            filters={
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
            }
            controls={
              <>
                {finalCount === null ? null : (
                  <span className={styles.summaryCount}>
                    {pluralize(finalCount, "followed show")}
                  </span>
                )}
                {hasActiveFilters ? (
                  <Button variant="secondary" size="md" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  size="md"
                  onClick={() =>
                    dispatchOpenLauncher({ kind: "Root", lane: "browse" })
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
        notice={error ? <FeedbackNotice feedback={error} /> : undefined}
        empty={
          <FeedbackNotice severity="neutral">
            {hasActiveFilters ? (
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
                    dispatchOpenLauncher({ kind: "Root", lane: "browse" })
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

      <PodcastSubscriptionSettingsModal
        podcastTitle={settingsRow?.title ?? null}
        settingsModal={settingsModal}
      />
    </>
  );
}
