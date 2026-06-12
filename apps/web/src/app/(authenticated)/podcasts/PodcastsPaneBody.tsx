"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MediaImage from "@/components/ui/MediaImage";
import { formatPlaybackSpeedLabel } from "@/lib/player/subscriptionPlaybackSpeed";
import { apiFetch } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { podcastResourceOptions } from "@/lib/actions/resourceActions";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { pluralize } from "@/lib/text/pluralize";
import LibraryColorDot from "@/components/LibraryColorDot";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
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
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import styles from "./page.module.css";

const PAGE_SIZE = 100;

type SubscriptionSort = "recent_episode" | "unplayed_count" | "alpha";
type SubscriptionFilter = "all" | "has_new" | "not_in_library";

function formatLatestEpisodeLabel(
  value: string | null,
  display: RenderEnvironment,
): string {
  if (!value) {
    return "No synced episodes yet";
  }
  const formatted = formatDisplayDate(value, display, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (!formatted) {
    return "No synced episodes yet";
  }
  return `Latest ${formatted}`;
}

export default function PodcastsPaneBody() {
  const display = useRenderEnvironment();
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const [rows, setRows] = useState<PodcastSubscriptionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const actions = usePodcastSubscriptionActions(setError);
  const [subscriptionSort, setSubscriptionSort] = useState<SubscriptionSort>("recent_episode");
  const [subscriptionFilter, setSubscriptionFilter] = useState<SubscriptionFilter>("all");
  const [searchText, setSearchText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [libraries, setLibraries] = useState<MemberLibrary[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>("");
  const [librariesByPodcastId, setLibrariesByPodcastId] = useState<
    Record<string, PodcastLibraryMembership[]>
  >({});
  const loadingLibraryPodcastIds = useStringIdSet();
  const busyLibraryMembershipKeys = actions.busyLibraryMembershipKeys;
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

  const subscriptionListResource = useResource<
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
        if (handleUnauthenticatedApiError(loadError)) return;
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
          [podcastId]: patchLibraryMembership(prev[podcastId] ?? [], libraryId, true),
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
                { id: summary.id, name: summary.name, color: summary.color ?? null },
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
          [podcastId]: patchLibraryMembership(prev[podcastId] ?? [], libraryId, false),
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
    ? (librariesByPodcastId[membershipPanelPodcastId] ?? [])
    : [];

  return (
    <>
      <PaneSurface
        toolbar={
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
        }
        state={
          loading || error ? (
            <>
              {loading ? <PaneLoadingState /> : null}
              {error ? <FeedbackNotice feedback={error} /> : null}
            </>
          ) : undefined
        }
        empty={
          !loading && rows.length === 0 && !error ? (
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
          ) : undefined
        }
        footer={
          hasMore ? (
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                void loadMoreSubscriptions();
              }}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load more"}
            </Button>
          ) : undefined
        }
      >
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

        {rows.length > 0 ? (
          <ResourceList>
            {rows.map((row) => {
              const rowBusy = actions.unsubscribingPodcastIds.ids.has(row.podcast_id);
              const rowRefreshing = actions.refreshingPodcastIds.ids.has(row.podcast_id);

              return (
                <ResourceRow
                  key={row.podcast_id}
                  primary={{
                    kind: "link",
                    href: `/podcasts/${row.podcast_id}`,
                    paneTitleHint: row.podcast.title,
                  }}
                  leading={
                    row.podcast.image_url ? (
                      <MediaImage
                        kind="proxied"
                        remoteUrl={row.podcast.image_url}
                        alt=""
                        width={32}
                        height={32}
                        className={styles.podcastArtwork}
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
                        {formatLatestEpisodeLabel(
                          row.latest_episode_published_at,
                          display,
                        )}
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
                          <LibraryColorDot color={library.color} size="sm" />
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
                  contributors={
                    row.podcast.contributors.length > 0 ? (
                      <ContributorCreditList
                        credits={row.podcast.contributors}
                        className={styles.rowAuthor}
                        maxVisible={2}
                      />
                    ) : undefined
                  }
                  actions={
                    <ActionMenu
                      options={podcastResourceOptions({
                        canUsePodcastActions: true,
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
                      })}
                    />
                  }
                />
              );
            })}
          </ResourceList>
        ) : null}
      </PaneSurface>

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
