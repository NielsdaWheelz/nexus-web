"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { formatPlaybackSpeedLabel } from "@/lib/player/subscriptionPlaybackSpeed";
import { apiFetch } from "@/lib/api/client";
import { useAsyncResource } from "@/lib/useAsyncResource";
import { podcastResourceOptions } from "@/lib/actions/resourceActions";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { pluralize } from "@/lib/text/pluralize";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import SectionCard from "@/components/ui/SectionCard";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { AppList, AppListItem } from "@/components/ui/AppList";
import {
  addPodcastToLibrary,
  buildPodcastUnsubscribeConfirmation,
  fetchPodcastLibraries,
  getPodcastSubscriptionSettingsPatch,
  getPodcastSubscriptionSyncPatch,
  type PodcastLibraryMembership,
  type PodcastSubscriptionListItem,
  removePodcastFromLibrary,
  refreshPodcastSubscriptionSync,
  unsubscribeFromPodcast,
} from "./podcastSubscriptions";
import { usePodcastSubscriptionSettingsModal } from "./usePodcastSubscriptionSettingsModal";
import PodcastSubscriptionSettingsModal from "./PodcastSubscriptionSettingsModal";
import { patchLibraryMembership } from "@/lib/media/mediaLibraries";
import { useNonDefaultLibraries } from "@/lib/media/useNonDefaultLibraries";
import { useStringIdSet } from "@/lib/useStringIdSet";
import styles from "./page.module.css";

const PAGE_SIZE = 100;

type SubscriptionSort = "recent_episode" | "unplayed_count" | "alpha";
type SubscriptionFilter = "all" | "has_new" | "not_in_library";

function formatLatestEpisodeLabel(value: string | null): string {
  if (!value) {
    return "No synced episodes yet";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "No synced episodes yet";
  }
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) {
    return "Latest today";
  }
  if (days === 1) {
    return "Latest yesterday";
  }
  if (days < 30) {
    return `Latest ${days}d ago`;
  }
  return `Latest ${new Date(timestamp).toLocaleDateString()}`;
}

export default function PodcastsPaneBody() {
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const [rows, setRows] = useState<PodcastSubscriptionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const busyPodcastIds = useStringIdSet();
  const refreshingPodcastIds = useStringIdSet();
  const [subscriptionSort, setSubscriptionSort] = useState<SubscriptionSort>("recent_episode");
  const [subscriptionFilter, setSubscriptionFilter] = useState<SubscriptionFilter>("all");
  const [searchText, setSearchText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const availableLibraries = useNonDefaultLibraries();
  const libraries = availableLibraries.libraries;
  const librariesLoading = availableLibraries.loading;
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>("");
  const [librariesByPodcastId, setLibrariesByPodcastId] = useState<
    Record<string, PodcastLibraryMembership[]>
  >({});
  const loadingLibraryPodcastIds = useStringIdSet();
  const busyLibraryMembershipKeys = useStringIdSet();
  const [membershipPanelPodcastId, setMembershipPanelPodcastId] = useState<string | null>(null);
  const [membershipPanelTriggerEl, setMembershipPanelTriggerEl] = useState<HTMLElement | null>(
    null
  );
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

  const subscriptionListResource = useAsyncResource<
    PodcastSubscriptionListItem[]
  >({
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

  const { load: loadAvailableLibraries } = availableLibraries;
  useEffect(() => {
    void loadAvailableLibraries();
  }, [loadAvailableLibraries]);

  useEffect(() => {
    if (availableLibraries.error) {
      setError(availableLibraries.error);
    }
  }, [availableLibraries.error]);

  const loadMoreSubscriptions = useCallback(
    async () => {
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
          { signal: controller.signal }
        );
        if (subscriptionRequestIdRef.current !== requestId) {
          return;
        }
        setRows((prev) => [...prev, ...response.data]);
        setHasMore(response.data.length === PAGE_SIZE);
        setNextOffset(offset + response.data.length);
      } catch (loadError) {
        if (controller.signal.aborted || subscriptionRequestIdRef.current !== requestId) {
          return;
        }
        setError(toFeedback(loadError, { fallback: "Failed to load followed podcasts" }));
      } finally {
        if (subscriptionRequestIdRef.current !== requestId) {
          return;
        }
        if (subscriptionAbortRef.current === controller) {
          subscriptionAbortRef.current = null;
        }
        setLoadingMore(false);
      }
    },
    [
      appliedSearch,
      hasMore,
      loadingMore,
      nextOffset,
      selectedLibraryId,
      subscriptionFilter,
      subscriptionSort,
    ],
  );

  useEffect(() => {
    return () => {
      subscriptionRequestIdRef.current += 1;
      subscriptionAbortRef.current?.abort();
    };
  }, []);

  const loadPodcastLibraries = useCallback(
    async (podcastId: string, force = false) => {
      if (!force && loadingLibraryPodcastIds.ids.has(podcastId)) {
        return librariesByPodcastId[podcastId] ?? [];
      }
      if (!force && librariesByPodcastId[podcastId]) {
        return librariesByPodcastId[podcastId];
      }
      loadingLibraryPodcastIds.add(podcastId);
      setError(null);
      try {
        const nextLibraries = await fetchPodcastLibraries(podcastId);
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: nextLibraries,
        }));
        return nextLibraries;
      } catch (loadError) {
        setError(toFeedback(loadError, { fallback: "Failed to load podcast libraries" }));
        return [];
      } finally {
        loadingLibraryPodcastIds.remove(podcastId);
      }
    },
    [librariesByPodcastId, loadingLibraryPodcastIds]
  );

  const handleAddPodcastToLibrary = useCallback(
    async (podcastId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${podcastId}`;
      busyLibraryMembershipKeys.add(busyKey);
      setError(null);
      try {
        await addPodcastToLibrary(podcastId, libraryId);
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
            const summary = libraries.find((library) => library.id === libraryId);
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
          })
        );
      } catch (mutationError) {
        setError(toFeedback(mutationError, { fallback: "Failed to add podcast to library" }));
      } finally {
        busyLibraryMembershipKeys.remove(busyKey);
      }
    },
    [busyLibraryMembershipKeys, libraries]
  );

  const handleRemovePodcastFromLibrary = useCallback(
    async (podcastId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${podcastId}`;
      busyLibraryMembershipKeys.add(busyKey);
      setError(null);
      try {
        await removePodcastFromLibrary(podcastId, libraryId);
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
                    (library) => library.id !== libraryId
                  ),
                }
              : row
          )
        );
      } catch (mutationError) {
        setError(
          toFeedback(mutationError, { fallback: "Failed to remove podcast from library" })
        );
      } finally {
        busyLibraryMembershipKeys.remove(busyKey);
      }
    },
    [busyLibraryMembershipKeys]
  );

  const handleUnsubscribe = useCallback(
    async (row: PodcastSubscriptionListItem) => {
      const currentLibraries = await loadPodcastLibraries(row.podcast_id, true);
      if (
        !window.confirm(
          buildPodcastUnsubscribeConfirmation(row.podcast.title, currentLibraries)
        )
      ) {
        return;
      }

      busyPodcastIds.add(row.podcast_id);
      setError(null);
      try {
        await unsubscribeFromPodcast(row.podcast_id);
        setRows((prev) => prev.filter((candidate) => candidate.podcast_id !== row.podcast_id));
        if (membershipPanelPodcastId === row.podcast_id) {
          setMembershipPanelPodcastId(null);
          setMembershipPanelTriggerEl(null);
        }
        setLibrariesByPodcastId((prev) => {
          const next = { ...prev };
          delete next[row.podcast_id];
          return next;
        });
      } catch (unsubscribeError) {
        setError(
          toFeedback(unsubscribeError, { fallback: "Failed to unsubscribe from podcast" })
        );
      } finally {
        busyPodcastIds.remove(row.podcast_id);
      }
    },
    [busyPodcastIds, loadPodcastLibraries, membershipPanelPodcastId]
  );

  const handleRefreshSync = useCallback(async (podcastId: string) => {
    refreshingPodcastIds.add(podcastId);
    setError(null);
    try {
      const response = await refreshPodcastSubscriptionSync(podcastId);
      setRows((prev) =>
        prev.map((row) =>
          row.podcast_id === podcastId
            ? {
                ...row,
                ...getPodcastSubscriptionSyncPatch(response),
              }
            : row
        )
      );
    } catch (refreshError) {
      setError(toFeedback(refreshError, { fallback: "Failed to refresh podcast sync" }));
    } finally {
      refreshingPodcastIds.remove(podcastId);
    }
  }, [refreshingPodcastIds]);

  const activeCount = rows.length;
  const settingsRow =
    settingsModal.podcastId !== null
      ? (rows.find((row) => row.podcast_id === settingsModal.podcastId) ?? null)
      : null;
  const hasActiveFilters =
    appliedSearch.length > 0 || subscriptionFilter !== "all" || selectedLibraryId.length > 0;
  const membershipPanelBusy = membershipPanelPodcastId
    ? Array.from(busyLibraryMembershipKeys.ids).some((key) =>
        key.endsWith(`:${membershipPanelPodcastId}`)
      )
    : false;
  const membershipPanelLibraries = membershipPanelPodcastId
    ? (librariesByPodcastId[membershipPanelPodcastId] ?? []).map((library) => ({
        ...library,
        canAdd: membershipPanelBusy ? false : library.canAdd,
        canRemove: membershipPanelBusy ? false : library.canRemove,
      }))
    : [];

  return (
    <>
      <SectionCard>
        <div className={styles.content}>
          <div className={styles.toolbar}>
            <form
              className={styles.searchForm}
              onSubmit={(event) => {
                event.preventDefault();
                setAppliedSearch(searchText.trim());
              }}
            >
              <Input
                className={styles.searchInputField}
                type="search"
                value={searchText}
                placeholder="Search followed podcasts..."
                onChange={(event) => setSearchText(event.target.value)}
              />
              <Button type="submit" variant="primary" size="md">
                Search
              </Button>
            </form>

            <div className={styles.toolbarControls}>
              <label className={styles.selectField}>
                <span>Filter</span>
                <Select
                  value={subscriptionFilter}
                  onChange={(event) =>
                    setSubscriptionFilter(event.target.value as SubscriptionFilter)
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
                  onChange={(event) => setSelectedLibraryId(event.target.value)}
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
                    setSubscriptionSort(event.target.value as SubscriptionSort)
                  }
                >
                  <option value="recent_episode">Recent Episode</option>
                  <option value="unplayed_count">Most Unplayed</option>
                  <option value="alpha">A-Z</option>
                </Select>
              </label>

              <Button
                variant="primary"
                size="md"
                onClick={() => openInNewPane?.("/browse?types=podcasts")}
              >
                Browse
              </Button>

              <ActionMenu
                label="Podcast page actions"
                options={[
                  {
                    id: "export-opml",
                    label: "Export OPML",
                    href: "/api/podcasts/export/opml",
                  },
                ]}
              />
            </div>
          </div>

          <div className={styles.summaryRow}>
            <span className={styles.summaryCount}>
              {pluralize(activeCount, "followed show")}
            </span>
            {hasActiveFilters ? (
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setSearchText("");
                  setAppliedSearch("");
                  setSubscriptionFilter("all");
                  setSelectedLibraryId("");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>

          {loading ? (
            <FeedbackNotice severity="info" title="Loading followed podcasts..." />
          ) : null}
          {error ? <FeedbackNotice feedback={error} /> : null}

          {!loading && rows.length === 0 && !error ? (
            <FeedbackNotice severity="neutral">
              {hasActiveFilters ? (
                <>
                  No podcasts match the current filters.{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.inlineButton}
                    onClick={() => {
                      setSearchText("");
                      setAppliedSearch("");
                      setSubscriptionFilter("all");
                      setSelectedLibraryId("");
                    }}
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
                    onClick={() => openInNewPane?.("/browse?types=podcasts")}
                  >
                    Browse podcasts
                  </Button>
                </>
              )}
            </FeedbackNotice>
          ) : null}

          {rows.length > 0 ? (
            <AppList>
              {rows.map((row) => {
                const rowBusy = busyPodcastIds.ids.has(row.podcast_id);
                const rowRefreshing = refreshingPodcastIds.ids.has(row.podcast_id);

                return (
                  <AppListItem
                    key={row.podcast_id}
                    href={`/podcasts/${row.podcast_id}`}
                    paneTitleHint={row.podcast.title}
                    icon={
                      row.podcast.image_url ? (
                        <Image
                          src={buildMediaImageProxySrc(row.podcast.image_url)}
                          alt=""
                          width={32}
                          height={32}
                          className={styles.podcastArtwork}
                          unoptimized
                        />
                      ) : (
                        <span className={styles.thumbnailFallback}>
                          {row.podcast.title
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((part) => part[0]?.toUpperCase() ?? "")
                            .join("") || "P"}
                        </span>
                      )
                    }
                    title={row.podcast.title}
                    description={
                      <span className={styles.rowDescription}>
                        <span className={styles.rowSummary}>
                          {row.podcast.description?.trim() || "No summary from source."}
                        </span>
                      </span>
                    }
                    meta={
                      <span className={styles.metaRow}>
                        <span className={styles.metaBadge}>
                          {formatLatestEpisodeLabel(row.latest_episode_published_at)}
                        </span>
                        {row.default_playback_speed != null ? (
                          <span className={styles.metaBadge}>
                            {formatPlaybackSpeedLabel(row.default_playback_speed)} default
                          </span>
                        ) : null}
                        {row.auto_queue ? (
                          <span className={styles.metaBadge}>Auto-queue</span>
                        ) : null}
                        {row.visible_libraries.map((library) => (
                          <span key={library.id} className={styles.libraryBadge}>
                            {library.color ? (
                              <span
                                className={styles.colorDot}
                                style={{ backgroundColor: library.color }}
                                aria-hidden="true"
                              />
                            ) : null}
                            {library.name}
                          </span>
                        ))}
                        {row.sync_status !== "complete" ? (
                          <span className={styles.syncBadge}>Sync {row.sync_status}</span>
                        ) : null}
                      </span>
                    }
                    trailing={
                      <span className={styles.trailing}>
                        {row.unplayed_count > 0 ? (
                          <span className={styles.unplayedBadge}>
                            {row.unplayed_count} new
                          </span>
                        ) : null}
                      </span>
                    }
                    actions={
                      row.podcast.contributors.length > 0 ? (
                        <ContributorCreditList
                          credits={row.podcast.contributors}
                          className={styles.rowAuthor}
                          maxVisible={2}
                        />
                      ) : undefined
                    }
                    options={podcastResourceOptions({
                      canUsePodcastActions: true,
                      busy: rowBusy,
                      refreshBusy: rowRefreshing,
                      unsubscribeBusy: rowBusy,
                      onManageLibraries: ({ triggerEl }) => {
                        setMembershipPanelPodcastId(row.podcast_id);
                        setMembershipPanelTriggerEl(triggerEl);
                        void loadPodcastLibraries(row.podcast_id);
                      },
                      onOpenSettings: () => settingsModal.open(row),
                      onRefreshSync: () => {
                        void handleRefreshSync(row.podcast_id);
                      },
                      onUnsubscribe: () => {
                        void handleUnsubscribe(row);
                      },
                    })}
                  />
                );
              })}
            </AppList>
          ) : null}

          {hasMore ? (
            <Button
              variant="secondary"
              size="md"
              className={styles.loadMoreButton}
              onClick={() => {
                void loadMoreSubscriptions();
              }}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load more"}
            </Button>
          ) : null}
        </div>
      </SectionCard>

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
            void handleAddPodcastToLibrary(membershipPanelPodcastId, libraryId);
          }
        }}
        onRemoveFromLibrary={(libraryId: string) => {
          if (membershipPanelPodcastId) {
            void handleRemovePodcastFromLibrary(membershipPanelPodcastId, libraryId);
          }
        }}
      />

      <PodcastSubscriptionSettingsModal settingsRow={settingsRow} settingsModal={settingsModal} />
    </>
  );
}
