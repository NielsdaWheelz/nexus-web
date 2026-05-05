"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
} from "@/lib/player/subscriptionPlaybackSpeed";
import { apiFetch } from "@/lib/api/client";
import { podcastResourceOptions } from "@/lib/actions/resourceActions";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import ActionMenu from "@/components/ui/ActionMenu";
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
  fetchNonDefaultLibraries,
  fetchPodcastLibraries,
  getPodcastSubscriptionSettingsDraft,
  getPodcastSubscriptionSettingsPatch,
  getPodcastSubscriptionSyncPatch,
  parsePodcastSubscriptionDefaultPlaybackSpeed,
  type LibrarySummary,
  type PodcastLibraryMembership,
  type PodcastSubscriptionListItem,
  removePodcastFromLibrary,
  refreshPodcastSubscriptionSync,
  savePodcastSubscriptionSettings,
  unsubscribeFromPodcast,
  updatePodcastLibraryMemberships,
} from "./podcastSubscriptions";
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
  const [rows, setRows] = useState<PodcastSubscriptionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<FeedbackContent | null>(null);
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
    Record<string, PodcastLibraryMembership[]>
  >({});
  const [loadingLibraryPodcastIds, setLoadingLibraryPodcastIds] = useState<Set<string>>(
    new Set()
  );
  const [busyLibraryMembershipKeys, setBusyLibraryMembershipKeys] = useState<Set<string>>(
    new Set()
  );
  const [membershipPanelPodcastId, setMembershipPanelPodcastId] = useState<string | null>(null);
  const [membershipPanelTriggerEl, setMembershipPanelTriggerEl] = useState<HTMLElement | null>(
    null
  );
  const [settingsPodcastId, setSettingsPodcastId] = useState<string | null>(null);
  const [settingsDefaultSpeed, setSettingsDefaultSpeed] = useState("default");
  const [settingsAutoQueue, setSettingsAutoQueue] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<FeedbackContent | null>(null);

  const loadLibraries = useCallback(async () => {
    if (librariesLoading) {
      return;
    }
    setLibrariesLoading(true);
    try {
      setLibraries(await fetchNonDefaultLibraries());
    } catch (loadError) {
      setError(toFeedback(loadError, { fallback: "Failed to load libraries" }));
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
        const response = await apiFetch<{ data: PodcastSubscriptionListItem[] }>(
          `/api/podcasts/subscriptions?${params.toString()}`
        );
        setRows((prev) => (append ? [...prev, ...response.data] : response.data));
        setHasMore(response.data.length === PAGE_SIZE);
        setNextOffset(offset + response.data.length);
      } catch (loadError) {
        setError(toFeedback(loadError, { fallback: "Failed to load followed podcasts" }));
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
        await addPodcastToLibrary(podcastId, libraryId);
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: updatePodcastLibraryMemberships(prev[podcastId] ?? [], {
            libraryId,
            isInLibrary: true,
          }),
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
        await removePodcastFromLibrary(podcastId, libraryId);
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: updatePodcastLibraryMemberships(prev[podcastId] ?? [], {
            libraryId,
            isInLibrary: false,
          }),
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
    async (row: PodcastSubscriptionListItem) => {
      const currentLibraries = await loadPodcastLibraries(row.podcast_id, true);
      if (
        !window.confirm(
          buildPodcastUnsubscribeConfirmation(row.podcast.title, currentLibraries)
        )
      ) {
        return;
      }

      setBusyPodcastIds((prev) => new Set(prev).add(row.podcast_id));
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
        setBusyPodcastIds((prev) => {
          const next = new Set(prev);
          next.delete(row.podcast_id);
          return next;
        });
      }
    },
    [loadPodcastLibraries, membershipPanelPodcastId]
  );

  const handleRefreshSync = useCallback(async (podcastId: string) => {
    setRefreshingPodcastIds((prev) => new Set(prev).add(podcastId));
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
      setRefreshingPodcastIds((prev) => {
        const next = new Set(prev);
        next.delete(podcastId);
        return next;
      });
    }
  }, []);

  const openSettingsModal = useCallback((row: PodcastSubscriptionListItem) => {
    const draft = getPodcastSubscriptionSettingsDraft(row);
    setSettingsPodcastId(row.podcast_id);
    setSettingsDefaultSpeed(draft.defaultSpeed);
    setSettingsAutoQueue(draft.autoQueue);
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
    try {
      const response = await savePodcastSubscriptionSettings(settingsRow.podcast_id, {
        defaultPlaybackSpeed: parsePodcastSubscriptionDefaultPlaybackSpeed(
          settingsDefaultSpeed
        ),
        autoQueue: settingsAutoQueue,
      });
      setRows((prev) =>
        prev.map((row) =>
          row.podcast_id === settingsRow.podcast_id
            ? {
                ...row,
                ...getPodcastSubscriptionSettingsPatch({
                  response,
                  updatedAt: row.updated_at,
                }),
              }
            : row
        )
      );
      setSettingsPodcastId(null);
    } catch (settingsUpdateError) {
      setSettingsError(
        toFeedback(settingsUpdateError, { fallback: "Failed to save subscription settings" })
      );
    } finally {
      setSettingsBusy(false);
    }
  }, [rows, settingsAutoQueue, settingsDefaultSpeed, settingsPodcastId]);

  const activeCount = rows.length;
  const settingsRow = rows.find((row) => row.podcast_id === settingsPodcastId) ?? null;
  const hasActiveFilters =
    appliedSearch.length > 0 || subscriptionFilter !== "all" || selectedLibraryId.length > 0;
  const membershipPanelBusy = membershipPanelPodcastId
    ? Array.from(busyLibraryMembershipKeys).some((key) =>
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
                onClick={() => requestOpenInAppPane("/browse?types=podcasts")}
              >
                Browse
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

          {loading ? (
            <FeedbackNotice severity="info" title="Loading followed podcasts..." />
          ) : null}
          {error ? <FeedbackNotice feedback={error} /> : null}

          {!loading && rows.length === 0 && !error ? (
            <FeedbackNotice severity="neutral">
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
                    onClick={() => requestOpenInAppPane("/browse?types=podcasts")}
                  >
                    Browse podcasts
                  </button>
                </>
              )}
            </FeedbackNotice>
          ) : null}

          {rows.length > 0 ? (
            <AppList>
              {rows.map((row) => {
                const rowBusy = busyPodcastIds.has(row.podcast_id);
                const rowRefreshing = refreshingPodcastIds.has(row.podcast_id);

                return (
                  <AppListItem
                    key={row.podcast_id}
                    href={`/podcasts/${row.podcast_id}`}
                    paneTitleHint={row.podcast.title}
                    icon={
                      row.podcast.image_url ? (
                        <Image
                          src={`/api/media/image?url=${encodeURIComponent(row.podcast.image_url)}`}
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
                      onOpenSettings: () => openSettingsModal(row),
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

      <LibraryMembershipPanel
        open={membershipPanelPodcastId !== null}
        title="Libraries"
        anchorEl={membershipPanelTriggerEl}
        libraries={membershipPanelLibraries}
        loading={
          membershipPanelPodcastId
            ? loadingLibraryPodcastIds.has(membershipPanelPodcastId)
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
            {settingsError ? <FeedbackNotice feedback={settingsError} /> : null}
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
