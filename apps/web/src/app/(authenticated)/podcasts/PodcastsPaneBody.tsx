"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { pluralize } from "@/lib/text/pluralize";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import PaneToolbar from "@/components/ui/PaneToolbar";
import CollectionView from "@/components/collections/CollectionView";
import CollectionDisplayControls from "@/components/collections/CollectionDisplayControls";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { useCollectionDisplayState } from "@/lib/collections/useCollectionDisplayState";
import { useConnectionSummaries } from "@/lib/collections/useConnectionSummaries";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  getPodcastSubscriptionSettingsPatch,
  type PodcastLibraryMembership,
  type PodcastSubscriptionListItem,
} from "./podcastSubscriptions";
import { usePodcastSubscriptionActions } from "./usePodcastSubscriptionActions";
import { usePodcastSubscriptionSettingsModal } from "./usePodcastSubscriptionSettingsModal";
import PodcastSubscriptionSettingsModal from "./PodcastSubscriptionSettingsModal";
import { patchLibraryMembership } from "@/lib/media/mediaLibraries";
import {
  listMemberLibraries,
  type MemberLibrary,
} from "@/lib/libraries/client";
import { useStringIdSet } from "@/lib/useStringIdSet";
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
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
  const { displayState, setDisplayState } =
    useCollectionDisplayState("/podcasts");
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
  const [rows, setRows] = useState<PodcastSubscriptionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const actions = usePodcastSubscriptionActions(setError);
  const subscriptionSort = podcastListState.sort;
  const subscriptionFilter = podcastListState.filter;
  const appliedSearch = podcastListState.query;
  const selectedLibraryId = podcastListState.libraryId;
  const [searchText, setSearchText] = useState(appliedSearch);
  const [libraries, setLibraries] = useState<MemberLibrary[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [librariesByPodcastId, setLibrariesByPodcastId] = useState<
    Record<string, PodcastLibraryMembership[]>
  >({});
  const loadingLibraryPodcastIds = useStringIdSet();
  const busyLibraryMembershipKeys = actions.busyLibraryMembershipKeys;
  const [membershipPanelPodcastId, setMembershipPanelPodcastId] = useState<
    string | null
  >(null);
  const [membershipPanelTriggerEl, setMembershipPanelTriggerEl] =
    useState<HTMLElement | null>(null);
  const subscriptionRequestIdRef = useRef(0);
  const subscriptionAbortRef = useRef<AbortController | null>(null);
  const settingsModal = usePodcastSubscriptionSettingsModal({
    onSaved: (response) => {
      setRows((prev) =>
        prev.map((row) =>
          row.podcast_id === response.podcast_id
            ? {
                ...row,
                ...getPodcastSubscriptionSettingsPatch({
                  response,
                  updatedAt: row.updated_at,
                }),
              }
            : row,
        ),
      );
    },
  });

  useEffect(() => {
    setSearchText(appliedSearch);
  }, [appliedSearch]);

  const subscriptionListResource = useResource<PodcastSubscriptionListItem[]>({
    cacheKey: [
      "podcast-subscriptions",
      subscriptionSort,
      subscriptionFilter,
      selectedLibraryId,
      appliedSearch,
    ].join(":"),
    load: async (signal) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: "0",
        sort: subscriptionSort,
        filter: subscriptionFilter,
      });
      if (appliedSearch) {
        params.set("q", appliedSearch);
      }
      if (selectedLibraryId) {
        params.set("library_id", selectedLibraryId);
      }
      const response = await apiFetch<{ data: PodcastSubscriptionListItem[] }>(
        `/api/podcasts/subscriptions?${params.toString()}`,
        { signal },
      );
      return response.data;
    },
  });

  useEffect(() => {
    if (subscriptionListResource.status === "loading") {
      subscriptionRequestIdRef.current += 1;
      subscriptionAbortRef.current?.abort();
      subscriptionAbortRef.current = null;
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      return;
    }

    if (subscriptionListResource.status === "ready") {
      setRows(subscriptionListResource.data);
      setHasMore(subscriptionListResource.data.length === PAGE_SIZE);
      setNextOffset(subscriptionListResource.data.length);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      return;
    }

    if (subscriptionListResource.status === "error") {
      setError(
        toFeedback(subscriptionListResource.error, {
          fallback: "Failed to load followed podcasts",
        }),
      );
      setLoading(false);
      setLoadingMore(false);
    }
  }, [subscriptionListResource]);

  useEffect(() => {
    let cancelled = false;
    setLibrariesLoading(true);
    void listMemberLibraries({ limit: 200 })
      .then((data) => {
        if (!cancelled) setLibraries(data);
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
  }, []);

  const loadMoreSubscriptions = useCallback(async () => {
    if (loadingMore || !hasMore) {
      return;
    }
    const offset = nextOffset;
    const requestId = subscriptionRequestIdRef.current + 1;
    const controller = new AbortController();
    subscriptionAbortRef.current?.abort();
    subscriptionRequestIdRef.current = requestId;
    subscriptionAbortRef.current = controller;

    setLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
        sort: subscriptionSort,
        filter: subscriptionFilter,
      });
      if (appliedSearch) {
        params.set("q", appliedSearch);
      }
      if (selectedLibraryId) {
        params.set("library_id", selectedLibraryId);
      }
      const response = await apiFetch<{ data: PodcastSubscriptionListItem[] }>(
        `/api/podcasts/subscriptions?${params.toString()}`,
        { signal: controller.signal },
      );
      if (subscriptionRequestIdRef.current !== requestId) {
        return;
      }
      setRows((prev) => [...prev, ...response.data]);
      setHasMore(response.data.length === PAGE_SIZE);
      setNextOffset(offset + response.data.length);
    } catch (loadError) {
      if (
        controller.signal.aborted ||
        subscriptionRequestIdRef.current !== requestId
      ) {
        return;
      }
      if (handleUnauthenticatedApiError(loadError)) return;
      setError(
        toFeedback(loadError, { fallback: "Failed to load followed podcasts" }),
      );
    } finally {
      if (subscriptionRequestIdRef.current !== requestId) {
        return;
      }
      if (subscriptionAbortRef.current === controller) {
        subscriptionAbortRef.current = null;
      }
      setLoadingMore(false);
    }
  }, [
    appliedSearch,
    hasMore,
    loadingMore,
    nextOffset,
    selectedLibraryId,
    subscriptionFilter,
    subscriptionSort,
  ]);

  useEffect(() => {
    return () => {
      subscriptionRequestIdRef.current += 1;
      subscriptionAbortRef.current?.abort();
    };
  }, []);

  // Populate the per-podcast library cache for the membership panel. The hook's
  // loadLibraries does the fetch + error reporting; this layer adds the
  // list-only keyed-map cache and in-flight dedupe.
  const ensurePodcastLibrariesLoaded = useCallback(
    async (podcastId: string) => {
      if (loadingLibraryPodcastIds.ids.has(podcastId)) {
        return;
      }
      if (librariesByPodcastId[podcastId]) {
        return;
      }
      loadingLibraryPodcastIds.add(podcastId);
      try {
        const nextLibraries = await actions.loadLibraries(podcastId);
        if (nextLibraries) {
          setLibrariesByPodcastId((prev) => ({
            ...prev,
            [podcastId]: nextLibraries,
          }));
        }
      } finally {
        loadingLibraryPodcastIds.remove(podcastId);
      }
    },
    [actions, librariesByPodcastId, loadingLibraryPodcastIds],
  );

  const addPodcastToLibrary = useCallback(
    (podcastId: string, libraryId: string) =>
      actions.addToLibrary(podcastId, libraryId, () => {
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: patchLibraryMembership(
            prev[podcastId] ?? [],
            libraryId,
            true,
          ),
        }));
        setRows((prev) =>
          prev.map((row) => {
            if (
              row.podcast_id !== podcastId ||
              row.visible_libraries.some((library) => library.id === libraryId)
            ) {
              return row;
            }
            const summary = libraries.find(
              (library) => library.id === libraryId,
            );
            if (!summary) {
              return row;
            }
            return {
              ...row,
              visible_libraries: [
                ...row.visible_libraries,
                {
                  id: summary.id,
                  name: summary.name,
                  color: summary.color ?? null,
                },
              ],
            };
          }),
        );
      }),
    [actions, libraries],
  );

  const removePodcastFromLibrary = useCallback(
    (podcastId: string, libraryId: string) =>
      actions.removeFromLibrary(podcastId, libraryId, () => {
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: patchLibraryMembership(
            prev[podcastId] ?? [],
            libraryId,
            false,
          ),
        }));
        setRows((prev) =>
          prev.map((row) =>
            row.podcast_id === podcastId
              ? {
                  ...row,
                  visible_libraries: row.visible_libraries.filter(
                    (library) => library.id !== libraryId,
                  ),
                }
              : row,
          ),
        );
      }),
    [actions],
  );

  const unsubscribePodcast = useCallback(
    (row: PodcastSubscriptionListItem) =>
      actions.unsubscribe(row.podcast_id, row.podcast.title, () => {
        setRows((prev) =>
          prev.filter((candidate) => candidate.podcast_id !== row.podcast_id),
        );
        if (membershipPanelPodcastId === row.podcast_id) {
          setMembershipPanelPodcastId(null);
          setMembershipPanelTriggerEl(null);
        }
        setLibrariesByPodcastId((prev) => {
          const next = { ...prev };
          delete next[row.podcast_id];
          return next;
        });
      }),
    [actions, membershipPanelPodcastId],
  );

  const refreshPodcastSync = useCallback(
    (podcastId: string) =>
      actions.refreshSync(podcastId, (patch) => {
        setRows((prev) =>
          prev.map((row) =>
            row.podcast_id === podcastId ? { ...row, ...patch } : row,
          ),
        );
      }),
    [actions],
  );

  const activeCount = rows.length;
  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: activeCount, unit: "show" },
      pending: loading,
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
  const membershipPanelBusy = membershipPanelPodcastId
    ? Array.from(busyLibraryMembershipKeys.ids).some((key) =>
        key.endsWith(`:${membershipPanelPodcastId}`),
      )
    : false;
  const membershipPanelLibraries = membershipPanelPodcastId
    ? (librariesByPodcastId[membershipPanelPodcastId] ?? [])
    : [];
  const connectionSummaries = useConnectionSummaries(
    rows.map((row) => `podcast:${row.podcast_id}`),
  );

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
        title: row.podcast.title,
        image_url: row.podcast.image_url,
        contributors: row.podcast.contributors,
        unplayed_count: row.unplayed_count,
        sync_status: row.sync_status,
        latest_episode_published_at: row.latest_episode_published_at,
      },
      {
        canUsePodcastActions: true,
        connectionSummary: connectionSummaries.get(`podcast:${row.podcast_id}`),
        busy: rowBusy,
        refreshBusy: rowRefreshing,
        unsubscribeBusy: rowBusy,
        onManageLibraries: ({ triggerEl }) => {
          setMembershipPanelPodcastId(row.podcast_id);
          setMembershipPanelTriggerEl(triggerEl);
          void ensurePodcastLibrariesLoaded(row.podcast_id);
        },
        onOpenSettings: () => settingsModal.open(row),
        onRefreshSync: () => {
          void refreshPodcastSync(row.podcast_id);
        },
        onUnsubscribe: () => {
          void unsubscribePodcast(row);
        },
      },
    );
  });

  return (
    <>
      <CollectionView
        rows={collectionRows}
        view={displayState.view}
        density={displayState.density}
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
                <span className={styles.summaryCount}>
                  {pluralize(activeCount, "followed show")}
                </span>
                <CollectionDisplayControls
                  value={displayState}
                  onChange={setDisplayState}
                />
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
        footer={
          <LoadMoreFooter
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={() => {
              void loadMoreSubscriptions();
            }}
            label="Load more"
          />
        }
      />

      <LibraryMembershipPanel
        open={membershipPanelPodcastId !== null}
        title="Libraries"
        anchorEl={membershipPanelTriggerEl}
        libraries={membershipPanelLibraries}
        loading={
          membershipPanelPodcastId
            ? loadingLibraryPodcastIds.ids.has(membershipPanelPodcastId)
            : false
        }
        busy={membershipPanelBusy}
        error={error?.title ?? null}
        emptyMessage="No non-default libraries available."
        onClose={() => {
          setMembershipPanelPodcastId(null);
          setMembershipPanelTriggerEl(null);
        }}
        onAddToLibrary={(libraryId: string) => {
          if (membershipPanelPodcastId) {
            void addPodcastToLibrary(membershipPanelPodcastId, libraryId);
          }
        }}
        onRemoveFromLibrary={(libraryId: string) => {
          if (membershipPanelPodcastId) {
            void removePodcastFromLibrary(membershipPanelPodcastId, libraryId);
          }
        }}
      />

      <PodcastSubscriptionSettingsModal
        podcastTitle={settingsRow?.podcast.title ?? null}
        settingsModal={settingsModal}
      />
    </>
  );
}
