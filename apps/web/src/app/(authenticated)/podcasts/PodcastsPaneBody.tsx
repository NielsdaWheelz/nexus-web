"use client";

import { useCallback, useEffect, useState } from "react";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
} from "@/lib/player/subscriptionPlaybackSpeed";
import { dispatchOpenAddContent } from "@/components/CommandPalette";
import { apiFetch, isApiError } from "@/lib/api/client";
import LibraryTargetPicker, {
  type LibraryTargetPickerItem,
} from "@/components/LibraryTargetPicker";
import ActionMenu from "@/components/ui/ActionMenu";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

const PAGE_SIZE = 100;

type SubscriptionSort = "recent_episode" | "unplayed_count" | "alpha";
type SubscriptionFilter = "all" | "has_new" | "not_in_library";

type LibrarySummary = {
  id: string;
  name: string;
  is_default: boolean;
  color?: string | null;
};

type PodcastSubscriptionVisibleLibrary = {
  id: string;
  name: string;
  color: string | null;
};

type PodcastListItem = {
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
};

type PodcastSubscriptionRow = {
  podcast_id: string;
  status: "active" | "unsubscribed";
  default_playback_speed?: number | null;
  auto_queue?: boolean;
  sync_status: "pending" | "running" | "partial" | "complete" | "source_limited" | "failed";
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
  unplayed_count: number;
  latest_episode_published_at: string | null;
  visible_libraries: PodcastSubscriptionVisibleLibrary[];
  podcast: PodcastListItem;
};

type PodcastSubscriptionSettingsResponse = {
  podcast_id: string;
  default_playback_speed: number | null;
  auto_queue: boolean;
  updated_at: string;
};

type PodcastSubscriptionSyncRefreshResult = {
  podcast_id: string;
  sync_status: PodcastSubscriptionRow["sync_status"];
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_enqueued: boolean;
};

function toTimestamp(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatLatestEpisodeLabel(value: string | null): string {
  const timestamp = toTimestamp(value);
  if (timestamp === 0) {
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
  const [rows, setRows] = useState<PodcastSubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyPodcastIds, setBusyPodcastIds] = useState<Set<string>>(new Set());
  const [refreshingPodcastIds, setRefreshingPodcastIds] = useState<Set<string>>(new Set());
  const [subscriptionSort, setSubscriptionSort] = useState<SubscriptionSort>("recent_episode");
  const [subscriptionFilter, setSubscriptionFilter] = useState<SubscriptionFilter>("all");
  const [searchText, setSearchText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>("");
  const [librariesByPodcastId, setLibrariesByPodcastId] = useState<
    Record<string, LibraryTargetPickerItem[]>
  >({});
  const [loadingLibraryPodcastIds, setLoadingLibraryPodcastIds] = useState<Set<string>>(
    new Set()
  );
  const [busyLibraryMembershipKeys, setBusyLibraryMembershipKeys] = useState<Set<string>>(
    new Set()
  );
  const [settingsPodcastId, setSettingsPodcastId] = useState<string | null>(null);
  const [settingsDefaultSpeed, setSettingsDefaultSpeed] = useState("default");
  const [settingsAutoQueue, setSettingsAutoQueue] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadLibraries = useCallback(async () => {
    if (librariesLoading) {
      return;
    }
    setLibrariesLoading(true);
    try {
      const response = await apiFetch<{ data: LibrarySummary[] }>("/api/libraries");
      setLibraries(response.data.filter((library) => !library.is_default));
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError("Failed to load libraries");
      }
    } finally {
      setLibrariesLoading(false);
    }
  }, [librariesLoading]);

  const loadSubscriptions = useCallback(
    async (offset = 0, append = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
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
        const response = await apiFetch<{ data: PodcastSubscriptionRow[] }>(
          `/api/podcasts/subscriptions?${params.toString()}`
        );
        setRows((prev) => (append ? [...prev, ...response.data] : response.data));
        setHasMore(response.data.length === PAGE_SIZE);
        setNextOffset(offset + response.data.length);
      } catch (loadError) {
        if (isApiError(loadError)) {
          setError(loadError.message);
        } else {
          setError("Failed to load followed podcasts");
        }
      } finally {
        if (append) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [appliedSearch, selectedLibraryId, subscriptionFilter, subscriptionSort]
  );

  const loadPodcastLibraries = useCallback(
    async (podcastId: string, force = false) => {
      if (!force && loadingLibraryPodcastIds.has(podcastId)) {
        return librariesByPodcastId[podcastId] ?? [];
      }
      if (!force && librariesByPodcastId[podcastId]) {
        return librariesByPodcastId[podcastId];
      }
      setLoadingLibraryPodcastIds((prev) => new Set(prev).add(podcastId));
      setError(null);
      try {
        const response = await apiFetch<{
          data: Array<{
            id: string;
            name: string;
            color: string | null;
            is_in_library: boolean;
            can_add: boolean;
            can_remove: boolean;
          }>;
        }>(`/api/podcasts/${podcastId}/libraries`);
        const nextLibraries = response.data.map((library) => ({
          id: library.id,
          name: library.name,
          color: library.color,
          isInLibrary: library.is_in_library,
          canAdd: library.can_add,
          canRemove: library.can_remove,
        }));
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: nextLibraries,
        }));
        return nextLibraries;
      } catch (loadError) {
        if (isApiError(loadError)) {
          setError(loadError.message);
        } else {
          setError("Failed to load podcast libraries");
        }
        return [];
      } finally {
        setLoadingLibraryPodcastIds((prev) => {
          const next = new Set(prev);
          next.delete(podcastId);
          return next;
        });
      }
    },
    [librariesByPodcastId, loadingLibraryPodcastIds]
  );

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  useEffect(() => {
    void loadSubscriptions(0, false);
  }, [loadSubscriptions]);

  const handleAddPodcastToLibrary = useCallback(
    async (podcastId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${podcastId}`;
      setBusyLibraryMembershipKeys((prev) => new Set(prev).add(busyKey));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/podcasts`, {
          method: "POST",
          body: JSON.stringify({ podcast_id: podcastId }),
        });
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: (prev[podcastId] ?? []).map((library) =>
            library.id === libraryId
              ? {
                  ...library,
                  isInLibrary: true,
                  canAdd: false,
                  canRemove: true,
                }
              : library
          ),
        }));
        setRows((prev) =>
          prev.map((row) => {
            if (row.podcast_id !== podcastId || row.visible_libraries.some((library) => library.id === libraryId)) {
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
        if (isApiError(mutationError)) {
          setError(mutationError.message);
        } else {
          setError("Failed to add podcast to library");
        }
      } finally {
        setBusyLibraryMembershipKeys((prev) => {
          const next = new Set(prev);
          next.delete(busyKey);
          return next;
        });
      }
    },
    [libraries]
  );

  const handleRemovePodcastFromLibrary = useCallback(
    async (podcastId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${podcastId}`;
      setBusyLibraryMembershipKeys((prev) => new Set(prev).add(busyKey));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/podcasts/${podcastId}`, {
          method: "DELETE",
        });
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: (prev[podcastId] ?? []).map((library) =>
            library.id === libraryId
              ? {
                  ...library,
                  isInLibrary: false,
                  canAdd: true,
                  canRemove: false,
                }
              : library
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
        if (isApiError(mutationError)) {
          setError(mutationError.message);
        } else {
          setError("Failed to remove podcast from library");
        }
      } finally {
        setBusyLibraryMembershipKeys((prev) => {
          const next = new Set(prev);
          next.delete(busyKey);
          return next;
        });
      }
    },
    []
  );

  const handleUnsubscribe = useCallback(
    async (row: PodcastSubscriptionRow) => {
      const currentLibraries = await loadPodcastLibraries(row.podcast_id, true);
      const removableLibraries = currentLibraries.filter(
        (library) => library.isInLibrary && library.canRemove
      );
      const retainedLibraries = currentLibraries.filter(
        (library) => library.isInLibrary && !library.canRemove
      );
      const confirmationLines = [
        `Unsubscribe from "${row.podcast.title}"?`,
        removableLibraries.length === 0
          ? "This podcast is not in any libraries you can change."
          : `This will remove the podcast from ${removableLibraries.length} librar${removableLibraries.length === 1 ? "y" : "ies"}.`,
      ];
      if (retainedLibraries.length > 0) {
        confirmationLines.push(
          `It will remain in ${retainedLibraries.length} shared librar${retainedLibraries.length === 1 ? "y" : "ies"} you cannot administer.`
        );
      }
      if (!window.confirm(confirmationLines.join("\n\n"))) {
        return;
      }

      setBusyPodcastIds((prev) => new Set(prev).add(row.podcast_id));
      setError(null);
      try {
        await apiFetch(`/api/podcasts/subscriptions/${row.podcast_id}`, {
          method: "DELETE",
        });
        setRows((prev) => prev.filter((candidate) => candidate.podcast_id !== row.podcast_id));
        setLibrariesByPodcastId((prev) => {
          const next = { ...prev };
          delete next[row.podcast_id];
          return next;
        });
      } catch (unsubscribeError) {
        if (isApiError(unsubscribeError)) {
          setError(unsubscribeError.message);
        } else {
          setError("Failed to unsubscribe from podcast");
        }
      } finally {
        setBusyPodcastIds((prev) => {
          const next = new Set(prev);
          next.delete(row.podcast_id);
          return next;
        });
      }
    },
    [loadPodcastLibraries]
  );

  const handleRefreshSync = useCallback(async (podcastId: string) => {
    setRefreshingPodcastIds((prev) => new Set(prev).add(podcastId));
    setError(null);
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionSyncRefreshResult }>(
        `/api/podcasts/subscriptions/${podcastId}/sync`,
        { method: "POST" }
      );
      setRows((prev) =>
        prev.map((row) =>
          row.podcast_id === podcastId
            ? {
                ...row,
                sync_status: response.data.sync_status,
                sync_error_code: response.data.sync_error_code,
                sync_error_message: response.data.sync_error_message,
                sync_attempts: response.data.sync_attempts,
              }
            : row
        )
      );
    } catch (refreshError) {
      if (isApiError(refreshError)) {
        setError(refreshError.message);
      } else {
        setError("Failed to refresh podcast sync");
      }
    } finally {
      setRefreshingPodcastIds((prev) => {
        const next = new Set(prev);
        next.delete(podcastId);
        return next;
      });
    }
  }, []);

  const openSettingsModal = useCallback((row: PodcastSubscriptionRow) => {
    setSettingsPodcastId(row.podcast_id);
    setSettingsDefaultSpeed(
      row.default_playback_speed == null ? "default" : String(row.default_playback_speed)
    );
    setSettingsAutoQueue(Boolean(row.auto_queue));
    setSettingsError(null);
  }, []);

  const closeSettingsModal = useCallback(() => {
    setSettingsPodcastId(null);
    setSettingsError(null);
    setSettingsBusy(false);
  }, []);

  const handleSaveSettings = useCallback(async () => {
    const settingsRow = rows.find((row) => row.podcast_id === settingsPodcastId) ?? null;
    if (!settingsRow) {
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    setError(null);
    const nextDefaultPlaybackSpeed =
      settingsDefaultSpeed === "default" ? null : Number.parseFloat(settingsDefaultSpeed);
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionSettingsResponse }>(
        `/api/podcasts/subscriptions/${settingsRow.podcast_id}/settings`,
        {
          method: "PATCH",
          body: JSON.stringify({
            default_playback_speed: nextDefaultPlaybackSpeed,
            auto_queue: settingsAutoQueue,
          }),
        }
      );
      setRows((prev) =>
        prev.map((row) =>
          row.podcast_id === settingsRow.podcast_id
            ? {
                ...row,
                default_playback_speed: response.data.default_playback_speed,
                auto_queue: response.data.auto_queue,
                updated_at: response.data.updated_at ?? row.updated_at,
              }
            : row
        )
      );
      setSettingsPodcastId(null);
    } catch (settingsUpdateError) {
      if (isApiError(settingsUpdateError)) {
        setSettingsError(settingsUpdateError.message);
      } else {
        setSettingsError("Failed to save subscription settings");
      }
    } finally {
      setSettingsBusy(false);
    }
  }, [rows, settingsAutoQueue, settingsDefaultSpeed, settingsPodcastId]);

  const activeCount = rows.length;
  const settingsRow = rows.find((row) => row.podcast_id === settingsPodcastId) ?? null;
  const hasActiveFilters =
    appliedSearch.length > 0 || subscriptionFilter !== "all" || selectedLibraryId.length > 0;

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
              <input
                className={styles.searchInput}
                type="search"
                value={searchText}
                placeholder="Search followed podcasts..."
                onChange={(event) => setSearchText(event.target.value)}
              />
              <button type="submit" className={styles.searchButton}>
                Search
              </button>
            </form>

            <div className={styles.toolbarControls}>
              <label className={styles.selectField}>
                <span>Filter</span>
                <select
                  value={subscriptionFilter}
                  onChange={(event) =>
                    setSubscriptionFilter(event.target.value as SubscriptionFilter)
                  }
                >
                  <option value="all">All</option>
                  <option value="has_new">Has New</option>
                  <option value="not_in_library">Not In Library</option>
                </select>
              </label>

              <label className={styles.selectField}>
                <span>Library</span>
                <select
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
                </select>
              </label>

              <label className={styles.selectField}>
                <span>Sort</span>
                <select
                  value={subscriptionSort}
                  onChange={(event) =>
                    setSubscriptionSort(event.target.value as SubscriptionSort)
                  }
                >
                  <option value="recent_episode">Recent Episode</option>
                  <option value="unplayed_count">Most Unplayed</option>
                  <option value="alpha">A-Z</option>
                </select>
              </label>

              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => dispatchOpenAddContent("podcast")}
              >
                Add
              </button>

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
              {activeCount} followed show{activeCount === 1 ? "" : "s"}
            </span>
            {hasActiveFilters ? (
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={() => {
                  setSearchText("");
                  setAppliedSearch("");
                  setSubscriptionFilter("all");
                  setSelectedLibraryId("");
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>

          {loading ? <StateMessage variant="loading">Loading followed podcasts...</StateMessage> : null}
          {error ? <StateMessage variant="error">{error}</StateMessage> : null}

          {!loading && rows.length === 0 && !error ? (
            <StateMessage variant="empty">
              {hasActiveFilters ? (
                <>
                  No podcasts match the current filters.{" "}
                  <button
                    type="button"
                    className={styles.inlineButton}
                    onClick={() => {
                      setSearchText("");
                      setAppliedSearch("");
                      setSubscriptionFilter("all");
                      setSelectedLibraryId("");
                    }}
                  >
                    Clear filters
                  </button>
                </>
              ) : (
                <>
                  No followed podcasts yet.{" "}
                  <button
                    type="button"
                    className={styles.inlineButton}
                    onClick={() => dispatchOpenAddContent("podcast")}
                  >
                    Add a podcast
                  </button>
                </>
              )}
            </StateMessage>
          ) : null}

          {rows.length > 0 ? (
            <AppList>
              {rows.map((row) => {
                const rowBusy = busyPodcastIds.has(row.podcast_id);
                const rowRefreshing = refreshingPodcastIds.has(row.podcast_id);
                const pickerLibraries = (librariesByPodcastId[row.podcast_id] ?? []).map(
                  (library) => {
                    const busyKey = `${library.id}:${row.podcast_id}`;
                    if (!busyLibraryMembershipKeys.has(busyKey)) {
                      return library;
                    }
                    return {
                      ...library,
                      canAdd: false,
                      canRemove: false,
                    };
                  }
                );

                return (
                  <AppListItem
                    key={row.podcast_id}
                    href={`/podcasts/${row.podcast_id}`}
                    paneTitleHint={row.podcast.title}
                    paneResourceRef={`podcast:${row.podcast_id}`}
                    icon={
                      row.podcast.image_url ? (
                        <span
                          className={styles.podcastArtwork}
                          style={{ backgroundImage: `url(${row.podcast.image_url})` }}
                          aria-hidden="true"
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
                          {row.podcast.description?.trim() ||
                            row.podcast.author ||
                            "No summary from source."}
                        </span>
                        {row.podcast.author ? (
                          <span className={styles.rowAuthor}>{row.podcast.author}</span>
                        ) : null}
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
                      <>
                        <LibraryTargetPicker
                          label="Libraries"
                          libraries={pickerLibraries}
                          loading={loadingLibraryPodcastIds.has(row.podcast_id)}
                          onOpen={() => {
                            void loadPodcastLibraries(row.podcast_id);
                          }}
                          onAddToLibrary={(libraryId) => {
                            void handleAddPodcastToLibrary(row.podcast_id, libraryId);
                          }}
                          onRemoveFromLibrary={(libraryId) => {
                            void handleRemovePodcastFromLibrary(row.podcast_id, libraryId);
                          }}
                          emptyMessage="No non-default libraries available."
                        />
                        <button
                          type="button"
                          className={styles.rowActionButton}
                          onClick={() => {
                            void handleUnsubscribe(row);
                          }}
                          disabled={rowBusy}
                        >
                          {rowBusy ? "Unsubscribing..." : "Unsubscribe"}
                        </button>
                      </>
                    }
                    options={[
                      {
                        id: "settings",
                        label: "Settings",
                        disabled: rowBusy,
                        onSelect: () => openSettingsModal(row),
                      },
                      {
                        id: "refresh-sync",
                        label: rowRefreshing ? "Refreshing..." : "Refresh sync",
                        disabled: rowRefreshing,
                        onSelect: () => {
                          void handleRefreshSync(row.podcast_id);
                        },
                      },
                    ]}
                  />
                );
              })}
            </AppList>
          ) : null}

          {hasMore ? (
            <button
              type="button"
              className={styles.loadMoreButton}
              onClick={() => {
                void loadSubscriptions(nextOffset, true);
              }}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          ) : null}
        </div>
      </SectionCard>

      {settingsRow ? (
        <div className={styles.modalBackdrop} role="presentation" onClick={closeSettingsModal}>
          <div
            className={styles.modalCard}
            role="dialog"
            aria-modal="true"
            aria-label="Podcast settings"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className={styles.modalTitle}>Podcast settings</h2>
            <p className={styles.modalDescription}>{settingsRow.podcast.title}</p>
            <label className={styles.settingsFieldLabel}>
              Default playback speed
              <select
                value={settingsDefaultSpeed}
                onChange={(event) => setSettingsDefaultSpeed(event.target.value)}
                className={styles.settingsSelect}
                aria-label="Default playback speed"
              >
                <option value="default">Use player default</option>
                {SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {formatPlaybackSpeedLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.settingsToggleLabel}>
              <input
                type="checkbox"
                checked={settingsAutoQueue}
                onChange={(event) => setSettingsAutoQueue(event.target.checked)}
                aria-label="Automatically add new episodes to my queue"
              />
              Automatically add new episodes to my queue
            </label>
            {settingsError ? <StateMessage variant="error">{settingsError}</StateMessage> : null}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => {
                  void handleSaveSettings();
                }}
                disabled={settingsBusy}
              >
                {settingsBusy ? "Saving..." : "Save subscription settings"}
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={closeSettingsModal}
                disabled={settingsBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
