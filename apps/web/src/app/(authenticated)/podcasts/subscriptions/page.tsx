"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { useSetPaneTitle } from "@/lib/panes/paneRuntime";
import PageLayout from "@/components/ui/PageLayout";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

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

export default function PodcastSubscriptionsPage() {
  const [rows, setRows] = useState<PodcastSubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPodcastIds, setBusyPodcastIds] = useState<Set<string>>(new Set());
  useSetPaneTitle("My podcasts");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionRow[] }>(
        "/api/podcasts/subscriptions?limit=100"
      );
      setRows(response.data);
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError("Failed to load subscriptions");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUnsubscribe = useCallback(async (podcastId: string) => {
    setBusyPodcastIds((prev) => new Set(prev).add(podcastId));
    setError(null);
    try {
      await apiFetch(`/api/podcasts/subscriptions/${podcastId}?mode=1`, {
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
      <SectionCard title="Subscriptions" actions={<span>{activeCount} active</span>}>
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
                meta={`${row.sync_status} sync`}
                trailing={<span className={styles.status}>{row.sync_status}</span>}
                actions={
                  <button
                    type="button"
                    className={styles.unsubscribeButton}
                    disabled={busyPodcastIds.has(row.podcast_id)}
                    aria-label={`Unsubscribe from ${row.podcast.title}`}
                    onClick={() => void handleUnsubscribe(row.podcast_id)}
                  >
                    {busyPodcastIds.has(row.podcast_id) ? "Unsubscribing..." : "Unsubscribe"}
                  </button>
                }
              />
            ))}
          </AppList>
        )}
      </SectionCard>
    </PageLayout>
  );
}
