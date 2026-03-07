"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, isApiError } from "@/lib/api/client";
import { usePaneParam, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import PageLayout from "@/components/ui/PageLayout";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

interface PodcastDetailItem {
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

interface PodcastSubscription {
  user_id: string;
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
}

interface PodcastDetailResponse {
  podcast: PodcastDetailItem;
  subscription: PodcastSubscription;
}

interface MediaCapabilities {
  can_read: boolean;
  can_highlight: boolean;
  can_quote: boolean;
  can_search: boolean;
  can_play: boolean;
  can_download_file: boolean;
}

interface PodcastEpisodeMedia {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  processing_status: string;
  failure_stage: string | null;
  last_error_code: string | null;
  playback_source:
    | {
        kind: "external_audio" | "external_video";
        stream_url: string;
        source_url: string;
      }
    | null;
  capabilities: MediaCapabilities;
  authors: Array<{ id: string; name: string; role: string | null }>;
  published_date: string | null;
  publisher: string | null;
  language: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface MeResponse {
  user_id: string;
  default_library_id: string;
}

interface LibraryMediaSummary {
  id: string;
}

export default function PodcastDetailPage() {
  const podcastId = usePaneParam("podcastId");
  const [detail, setDetail] = useState<PodcastDetailResponse | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisodeMedia[]>([]);
  const [defaultLibraryId, setDefaultLibraryId] = useState<string | null>(null);
  const [libraryMediaIds, setLibraryMediaIds] = useState<Set<string>>(new Set());
  const [busyMediaIds, setBusyMediaIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsubscribeBusy, setUnsubscribeBusy] = useState(false);

  useSetPaneTitle(detail?.podcast.title ?? "Podcast");

  const load = useCallback(async () => {
    if (!podcastId) {
      setLoading(false);
      setError("Podcast id is missing");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [detailResp, episodesResp, meResp] = await Promise.all([
        apiFetch<{ data: PodcastDetailResponse }>(`/api/podcasts/${podcastId}`),
        apiFetch<{ data: PodcastEpisodeMedia[] }>(`/api/podcasts/${podcastId}/episodes?limit=100`),
        apiFetch<{ data: MeResponse }>("/api/me"),
      ]);
      setDetail(detailResp.data);
      setEpisodes(episodesResp.data);
      setDefaultLibraryId(meResp.data.default_library_id);

      if (meResp.data.default_library_id) {
        const libraryResp = await apiFetch<{ data: LibraryMediaSummary[] }>(
          `/api/libraries/${meResp.data.default_library_id}/media`
        );
        setLibraryMediaIds(new Set(libraryResp.data.map((item) => item.id)));
      } else {
        setLibraryMediaIds(new Set());
      }
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError("Failed to load podcast detail");
      }
    } finally {
      setLoading(false);
    }
  }, [podcastId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAddToLibrary = useCallback(
    async (mediaId: string) => {
      if (!defaultLibraryId) {
        return;
      }
      setBusyMediaIds((prev) => new Set(prev).add(mediaId));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${defaultLibraryId}/media`, {
          method: "POST",
          body: JSON.stringify({ media_id: mediaId }),
        });
        setLibraryMediaIds((prev) => new Set(prev).add(mediaId));
      } catch (mutationError) {
        if (isApiError(mutationError)) {
          setError(mutationError.message);
        } else {
          setError("Failed to add episode to library");
        }
      } finally {
        setBusyMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [defaultLibraryId]
  );

  const handleRemoveFromLibrary = useCallback(
    async (mediaId: string) => {
      if (!defaultLibraryId) {
        return;
      }
      setBusyMediaIds((prev) => new Set(prev).add(mediaId));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${defaultLibraryId}/media/${mediaId}`, {
          method: "DELETE",
        });
        setLibraryMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      } catch (mutationError) {
        if (isApiError(mutationError)) {
          setError(mutationError.message);
        } else {
          setError("Failed to remove episode from library");
        }
      } finally {
        setBusyMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [defaultLibraryId]
  );

  const handleUnsubscribe = useCallback(async () => {
    if (!podcastId) {
      return;
    }
    setUnsubscribeBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/podcasts/subscriptions/${podcastId}?mode=1`, {
        method: "DELETE",
      });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              subscription: {
                ...prev.subscription,
                status: "unsubscribed",
                unsubscribe_mode: 1,
              },
            }
          : prev
      );
    } catch (unsubscribeError) {
      if (isApiError(unsubscribeError)) {
        setError(unsubscribeError.message);
      } else {
        setError("Failed to unsubscribe from podcast");
      }
    } finally {
      setUnsubscribeBusy(false);
    }
  }, [podcastId]);

  const activeEpisodeCount = useMemo(() => episodes.length, [episodes]);

  if (!podcastId) {
    return (
      <PageLayout title="Podcast" description="Podcast detail is unavailable.">
        <StateMessage variant="error">Podcast id is missing.</StateMessage>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title={detail?.podcast.title ?? "Podcast"}
      description={detail?.podcast.author || detail?.podcast.description || "Podcast detail"}
      actions={
        <Link href="/podcasts/subscriptions" className={styles.navLink}>
          My podcasts
        </Link>
      }
    >
      <SectionCard
        title="Subscription"
        description={detail?.podcast.feed_url || "Podcast subscription state"}
        actions={
          detail?.subscription.status === "active" ? (
            <button
              type="button"
              className={styles.unsubscribeButton}
              onClick={() => void handleUnsubscribe()}
              disabled={unsubscribeBusy}
              aria-label={`Unsubscribe from ${detail.podcast.title}`}
            >
              {unsubscribeBusy ? "Unsubscribing..." : "Unsubscribe"}
            </button>
          ) : (
            <span className={styles.unsubscribedLabel}>Unsubscribed</span>
          )
        }
      >
        {loading && <StateMessage variant="loading">Loading podcast detail...</StateMessage>}
        {error && <StateMessage variant="error">{error}</StateMessage>}
        {!loading && detail && (
          <p className={styles.syncState}>
            sync status: <strong>{detail.subscription.sync_status}</strong>
          </p>
        )}
      </SectionCard>

      <SectionCard title="Episodes" actions={<span>{activeEpisodeCount} episodes</span>}>
        {!loading && episodes.length === 0 && !error && (
          <StateMessage variant="empty">No episodes found for this podcast.</StateMessage>
        )}

        {episodes.length > 0 && (
          <AppList>
            {episodes.map((episode) => {
              const inLibrary = libraryMediaIds.has(episode.id);
              const busy = busyMediaIds.has(episode.id);
              const actionLabel = inLibrary
                ? `Remove ${episode.title} from library`
                : `Add ${episode.title} to library`;
              return (
                <AppListItem
                  key={episode.id}
                  href={`/media/${episode.id}`}
                  title={episode.title}
                  description={episode.capabilities.can_play ? "Playable episode" : "Processing"}
                  meta={episode.processing_status}
                  actions={
                    <button
                      type="button"
                      className={styles.libraryButton}
                      aria-label={actionLabel}
                      disabled={busy || !defaultLibraryId}
                      onClick={() =>
                        void (inLibrary
                          ? handleRemoveFromLibrary(episode.id)
                          : handleAddToLibrary(episode.id))
                      }
                    >
                      {busy ? "Saving..." : inLibrary ? "Remove from library" : "Add to library"}
                    </button>
                  }
                />
              );
            })}
          </AppList>
        )}
      </SectionCard>
    </PageLayout>
  );
}
