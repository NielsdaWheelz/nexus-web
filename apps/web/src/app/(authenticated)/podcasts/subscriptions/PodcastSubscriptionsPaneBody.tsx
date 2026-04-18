"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { useSetPaneTitle } from "@/lib/panes/paneRuntime";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
} from "@/lib/player/subscriptionPlaybackSpeed";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

const SUBSCRIPTIONS_PAGE_SIZE = 100;
type SubscriptionSort = "recent_episode" | "unplayed_count" | "alpha";

interface LibrarySummary {
  id: string;
  name: string;
  is_default: boolean;
  role: string;
}

interface LibraryEntrySummary {
  kind: "media" | "podcast";
  podcast?: {
    id: string;
  } | null;
}

interface PodcastListItem {
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
}

interface PodcastSubscriptionRow {
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
  podcast: PodcastListItem;
}

interface PodcastSubscriptionSettingsResponse {
  podcast_id: string;
  default_playback_speed: number | null;
  auto_queue: boolean;
  updated_at: string;
}

interface PodcastSubscriptionSyncRefreshResult {
  podcast_id: string;
  sync_status: PodcastSubscriptionRow["sync_status"];
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_enqueued: boolean;
}

interface PodcastOpmlImportResult {
  total: number;
  imported: number;
  skipped_already_subscribed: number;
  skipped_invalid: number;
  errors: Array<{
    feed_url: string | null;
    error: string;
  }>;
}

export default function PodcastSubscriptionsPaneBody() {
  const [rows, setRows] = useState<PodcastSubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyPodcastIds, setBusyPodcastIds] = useState<Set<string>>(new Set());
  const [refreshingPodcastIds, setRefreshingPodcastIds] = useState<Set<string>>(new Set());
  const [subscriptionSort, setSubscriptionSort] = useState<SubscriptionSort>("recent_episode");
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [libraryIdsByPodcastId, setLibraryIdsByPodcastId] = useState<Record<string, string[]>>({});
  const [busyLibraryMembershipKeys, setBusyLibraryMembershipKeys] = useState<Set<string>>(new Set());
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<PodcastOpmlImportResult | null>(null);
  const [settingsPodcastId, setSettingsPodcastId] = useState<string | null>(null);
  const [settingsDefaultSpeed, setSettingsDefaultSpeed] = useState<string>("default");
  const [settingsAutoQueue, setSettingsAutoQueue] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  useSetPaneTitle("My podcasts");

  const loadSubscriptions = useCallback(async (offset = 0, append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(SUBSCRIPTIONS_PAGE_SIZE),
        offset: String(offset),
        sort: subscriptionSort,
      });
      const response = await apiFetch<{ data: PodcastSubscriptionRow[] }>(
        `/api/podcasts/subscriptions?${params.toString()}`
      );
      const nextRows = response.data.filter((row) => row.status === "active");
      setRows((prev) => (append ? [...prev, ...nextRows] : nextRows));
      setHasMore(response.data.length === SUBSCRIPTIONS_PAGE_SIZE);
      setNextOffset(offset + response.data.length);
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError("Failed to load subscriptions");
      }
    } finally {
      if (append) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }, [subscriptionSort]);

  const loadLibraryMemberships = useCallback(async () => {
    try {
      const librariesResponse = await apiFetch<{ data: LibrarySummary[] }>("/api/libraries");
      const nextLibraries = librariesResponse.data.filter((library) => !library.is_default);
      setLibraries(nextLibraries);
      if (nextLibraries.length === 0) {
        setLibraryIdsByPodcastId({});
        return;
      }
      const entryResponses = await Promise.all(
        nextLibraries.map((library) =>
          apiFetch<{ data: LibraryEntrySummary[] }>(`/api/libraries/${library.id}/entries`)
        )
      );
      const nextLibraryIdsByPodcastId: Record<string, string[]> = {};
      for (let index = 0; index < nextLibraries.length; index += 1) {
        const library = nextLibraries[index];
        for (const entry of entryResponses[index].data) {
          if (entry.kind !== "podcast" || !entry.podcast) {
            continue;
          }
          const existingLibraryIds = nextLibraryIdsByPodcastId[entry.podcast.id] ?? [];
          nextLibraryIdsByPodcastId[entry.podcast.id] = [...existingLibraryIds, library.id];
        }
      }
      setLibraryIdsByPodcastId(nextLibraryIdsByPodcastId);
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError("Failed to load library memberships");
      }
      setLibraries([]);
      setLibraryIdsByPodcastId({});
    }
  }, []);

  useEffect(() => {
    void loadSubscriptions();
  }, [loadSubscriptions]);

  useEffect(() => {
    void loadLibraryMemberships();
  }, [loadLibraryMemberships]);

  const handleAddPodcastToLibrary = useCallback(async (podcastId: string, libraryId: string) => {
    const busyKey = `${libraryId}:${podcastId}`;
    setBusyLibraryMembershipKeys((prev) => new Set(prev).add(busyKey));
    setError(null);
    try {
      await apiFetch(`/api/libraries/${libraryId}/podcasts`, {
        method: "POST",
        body: JSON.stringify({ podcast_id: podcastId }),
      });
      setLibraryIdsByPodcastId((prev) => {
        const next = { ...prev };
        const nextLibraryIds = new Set(next[podcastId] ?? []);
        nextLibraryIds.add(libraryId);
        next[podcastId] = [...nextLibraryIds];
        return next;
      });
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
  }, []);

  const handleRemovePodcastFromLibrary = useCallback(async (podcastId: string, libraryId: string) => {
    const busyKey = `${libraryId}:${podcastId}`;
    setBusyLibraryMembershipKeys((prev) => new Set(prev).add(busyKey));
    setError(null);
    try {
      await apiFetch(`/api/libraries/${libraryId}/podcasts/${podcastId}`, {
        method: "DELETE",
      });
      setLibraryIdsByPodcastId((prev) => {
        const next = { ...prev };
        const nextLibraryIds = new Set(next[podcastId] ?? []);
        nextLibraryIds.delete(libraryId);
        if (nextLibraryIds.size === 0) {
          delete next[podcastId];
        } else {
          next[podcastId] = [...nextLibraryIds];
        }
        return next;
      });
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
  }, []);

  const handleUnsubscribe = useCallback(async (row: PodcastSubscriptionRow) => {
    const currentLibraryIds = new Set(libraryIdsByPodcastId[row.podcast_id] ?? []);
    const removableLibraries = libraries.filter(
      (library) => currentLibraryIds.has(library.id) && library.role === "admin"
    );
    const retainedLibraries = libraries.filter(
      (library) => currentLibraryIds.has(library.id) && library.role !== "admin"
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
      setLibraryIdsByPodcastId((prev) => {
        const next = { ...prev };
        if (retainedLibraries.length === 0) {
          delete next[row.podcast_id];
        } else {
          next[row.podcast_id] = retainedLibraries.map((library) => library.id);
        }
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
  }, [libraries, libraryIdsByPodcastId]);

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

  const activeCount = useMemo(() => rows.length, [rows]);
  const settingsRow = useMemo(
    () => rows.find((row) => row.podcast_id === settingsPodcastId) ?? null,
    [rows, settingsPodcastId]
  );

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
  }, [settingsAutoQueue, settingsDefaultSpeed, settingsRow]);

  const openImportModal = useCallback(() => {
    setImportError(null);
    setImportResult(null);
    setImportFile(null);
    setIsImportModalOpen(true);
  }, []);

  const closeImportModal = useCallback(() => {
    setIsImportModalOpen(false);
    setImportBusy(false);
  }, []);

  const handleImportOpml = useCallback(async () => {
    if (!importFile) {
      setImportError("Select an OPML/XML file to import.");
      return;
    }
    setImportBusy(true);
    setImportError(null);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      const response = await fetch("/api/podcasts/import/opml", {
        method: "POST",
        body: formData,
      });
      const responseBody = (await response.json().catch(() => null)) as
        | { data?: PodcastOpmlImportResult; error?: { message?: string } }
        | null;

      if (!response.ok) {
        throw new Error(responseBody?.error?.message || "Failed to import OPML file");
      }
      if (!responseBody?.data) {
        throw new Error("Import response missing summary payload");
      }

      setImportResult(responseBody.data);
      await loadSubscriptions(0, false);
      await loadLibraryMemberships();
    } catch (opmlImportError) {
      if (opmlImportError instanceof Error && opmlImportError.message) {
        setImportError(opmlImportError.message);
      } else {
        setImportError("Failed to import OPML file");
      }
    } finally {
      setImportBusy(false);
    }
  }, [importFile, loadLibraryMemberships, loadSubscriptions]);

  return (
    <>
      <SectionCard>
        <div className={styles.content}>
          <div className={styles.sectionActions}>
            <button
              type="button"
              className={styles.secondaryAction}
              onClick={openImportModal}
              aria-label="Import OPML"
            >
              Import OPML
            </button>
            <a
              href="/api/podcasts/export/opml"
              download="nexus-podcasts.opml"
              className={styles.secondaryAction}
              aria-label="Export OPML"
            >
              Export OPML
            </a>
            <span>{activeCount} active</span>
          </div>

          <div className={styles.sortRow}>
            <label htmlFor="subscription-sort" className={styles.sortLabel}>
              Subscription sort
            </label>
            <select
              id="subscription-sort"
              value={subscriptionSort}
              onChange={(event) => setSubscriptionSort(event.target.value as SubscriptionSort)}
              className={styles.sortSelect}
              aria-label="Subscription sort"
            >
              <option value="recent_episode">Recent Episode</option>
              <option value="unplayed_count">Most Unplayed</option>
              <option value="alpha">A-Z</option>
            </select>
          </div>

          {loading && <StateMessage variant="loading">Loading subscriptions...</StateMessage>}
          {error && <StateMessage variant="error">{error}</StateMessage>}

          {!loading && rows.length === 0 && !error && (
            <StateMessage variant="empty">
              No active podcast subscriptions yet. Discover podcasts to subscribe.
            </StateMessage>
          )}

          {rows.length > 0 && (
            <AppList>
              {rows.map((row) => {
                const rowBusy = busyPodcastIds.has(row.podcast_id);
                const rowRefreshing = refreshingPodcastIds.has(row.podcast_id);
                const currentLibraryIds = new Set(libraryIdsByPodcastId[row.podcast_id] ?? []);
                const libraryOptions = libraries.map((library) => {
                  const inLibrary = currentLibraryIds.has(library.id);
                  const busyKey = `${library.id}:${row.podcast_id}`;
                  return {
                    id: `${inLibrary ? "remove" : "add"}-${library.id}`,
                    label: `${inLibrary ? "Remove from" : "Add to"} ${library.name}`,
                    disabled: busyLibraryMembershipKeys.has(busyKey),
                    onSelect: () => {
                      void (inLibrary
                        ? handleRemovePodcastFromLibrary(row.podcast_id, library.id)
                        : handleAddPodcastToLibrary(row.podcast_id, library.id));
                    },
                  };
                });

                return (
                  <AppListItem
                    key={row.podcast_id}
                    href={`/podcasts/${row.podcast_id}`}
                    title={row.podcast.title}
                    description={row.podcast.author || "Unknown author"}
                    meta={
                      row.sync_error_code
                        ? `${row.sync_status} sync - ${row.sync_error_code}: ${row.sync_error_message || "unknown error"}`
                        : `${row.sync_status} sync`
                    }
                    trailing={
                      <span className={styles.trailing}>
                        {row.unplayed_count > 0 && (
                          <span className={styles.unplayedBadge}>{row.unplayed_count} new</span>
                        )}
                        <span className={styles.status}>
                          {currentLibraryIds.size} librar{currentLibraryIds.size === 1 ? "y" : "ies"}
                        </span>
                        <span className={styles.status}>{row.sync_status}</span>
                      </span>
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
                      ...libraryOptions,
                      {
                        id: "unsubscribe",
                        label: rowBusy ? "Unsubscribing..." : "Unsubscribe",
                        tone: "danger",
                        disabled: rowBusy,
                        onSelect: () => {
                          void handleUnsubscribe(row);
                        },
                      },
                    ]}
                  />
                );
              })}
            </AppList>
          )}

          {!loading && hasMore && (
            <button
              type="button"
              className={styles.loadMoreButton}
              disabled={loadingMore}
              onClick={() => void loadSubscriptions(nextOffset, true)}
              aria-label="Load more subscriptions"
            >
              {loadingMore ? "Loading..." : "Load more subscriptions"}
            </button>
          )}
        </div>
      </SectionCard>

      {settingsRow && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={`Subscription settings for ${settingsRow.podcast.title}`}
        >
          <div className={styles.modalCard}>
            <h3 className={styles.modalTitle}>Subscription settings</h3>
            <p className={styles.modalDescription}>
              Configure default playback behavior for <strong>{settingsRow.podcast.title}</strong>.
            </p>
            <label htmlFor="subscription-default-playback-speed" className={styles.settingsFieldLabel}>
              Default playback speed
            </label>
            <select
              id="subscription-default-playback-speed"
              className={styles.settingsSelect}
              value={settingsDefaultSpeed}
              onChange={(event) => setSettingsDefaultSpeed(event.target.value)}
              aria-label="Default playback speed"
            >
              <option value="default">Default (1.0x)</option>
              {SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={String(speed)}>
                  {formatPlaybackSpeedLabel(speed)}
                </option>
              ))}
            </select>
            <label className={styles.settingsToggleLabel}>
              <input
                type="checkbox"
                checked={settingsAutoQueue}
                onChange={(event) => setSettingsAutoQueue(event.target.checked)}
                aria-label="Automatically add new episodes to my queue"
              />
              <span>Automatically add new episodes to my queue</span>
            </label>
            <p className={styles.modalDescription}>
              New episodes from this podcast will be added to the end of your playback queue when
              they&apos;re synced.
            </p>
            {settingsError && <StateMessage variant="error">{settingsError}</StateMessage>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => void handleSaveSettings()}
                disabled={settingsBusy}
                aria-label="Save subscription settings"
              >
                {settingsBusy ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={closeSettingsModal}
                disabled={settingsBusy}
                aria-label="Close subscription settings"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {isImportModalOpen && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Import OPML">
          <div className={styles.modalCard}>
            <h3 className={styles.modalTitle}>Import OPML</h3>
            <p className={styles.modalDescription}>
              Upload an OPML or XML file to bulk subscribe podcasts.
            </p>
            <label htmlFor="opml-file-input" className={styles.fileLabel}>
              OPML file
            </label>
            <input
              id="opml-file-input"
              type="file"
              accept=".opml,.xml,application/xml,text/xml"
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setImportFile(selected);
              }}
              className={styles.fileInput}
              aria-label="OPML file"
            />

            {importError && <StateMessage variant="error">{importError}</StateMessage>}
            {importResult && (
              <div className={styles.importSummary}>
                <p className={styles.importSummaryTitle}>Import complete</p>
                <p>Total found: {importResult.total}</p>
                <p>Imported: {importResult.imported}</p>
                <p>Already subscribed: {importResult.skipped_already_subscribed}</p>
                <p>Invalid/skipped: {importResult.skipped_invalid}</p>
                {importResult.errors.length > 0 && (
                  <ul className={styles.importErrors}>
                    {importResult.errors.map((errorRow, index) => (
                      <li key={`${errorRow.feed_url ?? "missing-feed"}-${index}`}>
                        {errorRow.feed_url ? `${errorRow.feed_url}: ` : ""}
                        {errorRow.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => void handleImportOpml()}
                disabled={importBusy || !importFile}
                aria-label="Import"
              >
                {importBusy ? "Importing..." : "Import"}
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={closeImportModal}
                aria-label="Close"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
