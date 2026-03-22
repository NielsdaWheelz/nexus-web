"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { useSetPaneTitle } from "@/lib/panes/paneRuntime";
import PageLayout from "@/components/ui/PageLayout";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

const SUBSCRIPTIONS_PAGE_SIZE = 100;

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
  unsubscribe_mode: 1 | 2 | 3;
  sync_status: "pending" | "running" | "partial" | "complete" | "source_limited" | "failed";
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
  podcast: PodcastListItem;
}

interface PodcastSubscriptionSyncRefreshResult {
  podcast_id: string;
  sync_status: PodcastSubscriptionRow["sync_status"];
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_enqueued: boolean;
}

interface PodcastPlanSnapshot {
  plan: {
    plan_tier: "free" | "paid";
    daily_transcription_minutes: number | null;
    initial_episode_window: number;
  };
  usage: {
    usage_date: string;
    used_minutes: number;
    reserved_minutes: number;
    total_minutes: number;
    remaining_minutes: number | null;
  };
}

export default function PodcastSubscriptionsPage() {
  const [rows, setRows] = useState<PodcastSubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busyPodcastIds, setBusyPodcastIds] = useState<Set<string>>(new Set());
  const [refreshingPodcastIds, setRefreshingPodcastIds] = useState<Set<string>>(new Set());
  const [unsubscribeMode, setUnsubscribeMode] = useState<1 | 2 | 3>(1);
  const [plan, setPlan] = useState<PodcastPlanSnapshot | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  useSetPaneTitle("My podcasts");

  const loadSubscriptions = useCallback(async (offset = 0, append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionRow[] }>(
        `/api/podcasts/subscriptions?limit=${SUBSCRIPTIONS_PAGE_SIZE}&offset=${offset}`
      );
      setRows((prev) => (append ? [...prev, ...response.data] : response.data));
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
  }, []);

  const loadPlanSnapshot = useCallback(async () => {
    setPlanLoading(true);
    setPlanError(null);
    try {
      const response = await apiFetch<{ data: PodcastPlanSnapshot }>("/api/podcasts/plan");
      setPlan(response.data);
    } catch (loadError) {
      if (isApiError(loadError)) {
        setPlanError(loadError.message);
      } else {
        setPlanError("Failed to load plan and quota snapshot");
      }
    } finally {
      setPlanLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSubscriptions();
    void loadPlanSnapshot();
  }, [loadPlanSnapshot, loadSubscriptions]);

  const handleUnsubscribe = useCallback(async (podcastId: string) => {
    setBusyPodcastIds((prev) => new Set(prev).add(podcastId));
    setError(null);
    try {
      await apiFetch(`/api/podcasts/subscriptions/${podcastId}?mode=${unsubscribeMode}`, {
        method: "DELETE",
      });
      setRows((prev) => prev.filter((row) => row.podcast_id !== podcastId));
    } catch (unsubscribeError) {
      if (isApiError(unsubscribeError)) {
        setError(unsubscribeError.message);
      } else {
        setError("Failed to unsubscribe from podcast");
      }
    } finally {
      setBusyPodcastIds((prev) => {
        const next = new Set(prev);
        next.delete(podcastId);
        return next;
      });
    }
  }, [unsubscribeMode]);

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

  const activeCount = useMemo(
    () => rows.filter((row) => row.status === "active").length,
    [rows]
  );

  return (
    <PageLayout
      title="My podcasts"
      description="Manage subscriptions and jump into podcast episode detail."
    >
      <SectionCard title="Plan and quota">
        {planLoading && <StateMessage variant="loading">Loading plan snapshot...</StateMessage>}
        {planError && <StateMessage variant="error">{planError}</StateMessage>}
        {plan && (
          <>
            <p className={styles.planSummary}>
              Plan <strong>{plan.plan.plan_tier}</strong> - window{" "}
              <strong>{plan.plan.initial_episode_window}</strong> episodes - used{" "}
              <strong>{plan.usage.total_minutes}</strong> minutes today
              {plan.usage.remaining_minutes === null
                ? " (unlimited remaining)"
                : ` (${plan.usage.remaining_minutes} remaining)`}
            </p>
            <p className={styles.planSummary}>Plan changes are managed by internal billing controls.</p>
          </>
        )}
      </SectionCard>

      <SectionCard title="Subscriptions" actions={<span>{activeCount} active</span>}>
        <div className={styles.unsubscribeModeRow}>
          <label htmlFor="unsubscribe-mode" className={styles.unsubscribeModeLabel}>
            Unsubscribe behavior
          </label>
          <select
            id="unsubscribe-mode"
            value={String(unsubscribeMode)}
            onChange={(event) => setUnsubscribeMode(Number(event.target.value) as 1 | 2 | 3)}
            className={styles.unsubscribeModeSelect}
            aria-label="Unsubscribe behavior"
          >
            <option value="1">Keep episodes in libraries</option>
            <option value="2">Remove from default library</option>
            <option value="3">Remove from default and single-member libraries</option>
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
            {rows.map((row) => (
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
                trailing={<span className={styles.status}>{row.sync_status}</span>}
                actions={
                  <>
                    <button
                      type="button"
                      className={styles.syncButton}
                      disabled={refreshingPodcastIds.has(row.podcast_id)}
                      aria-label={`Refresh sync for ${row.podcast.title}`}
                      onClick={() => void handleRefreshSync(row.podcast_id)}
                    >
                      {refreshingPodcastIds.has(row.podcast_id) ? "Refreshing..." : "Refresh sync"}
                    </button>
                    <button
                      type="button"
                      className={styles.unsubscribeButton}
                      disabled={busyPodcastIds.has(row.podcast_id)}
                      aria-label={`Unsubscribe from ${row.podcast.title}`}
                      onClick={() => void handleUnsubscribe(row.podcast_id)}
                    >
                      {busyPodcastIds.has(row.podcast_id) ? "Unsubscribing..." : "Unsubscribe"}
                    </button>
                  </>
                }
              />
            ))}
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
      </SectionCard>
    </PageLayout>
  );
}
