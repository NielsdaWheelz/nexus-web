"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import PageLayout from "@/components/ui/PageLayout";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import { AppList, AppListItem } from "@/components/ui/AppList";
import MediaKindIcon from "@/components/MediaKindIcon";
import styles from "./MediaCatalogPage.module.css";

export type MediaKind =
  | "web_article"
  | "epub"
  | "pdf"
  | "podcast_episode"
  | "video";

interface MediaCatalogPageProps {
  title: string;
  description: string;
  allowedKinds: MediaKind[];
  emptyMessage: string;
  headerSlot?: React.ReactNode;
  /** Called when user requests deletion of a media item. */
  onDeleteItem?: (itemId: string) => void;
}

interface MediaItemResponse {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  processing_status: string;
  created_at: string;
  updated_at: string;
}

interface MediaListResponse {
  data: MediaItemResponse[];
  page: {
    next_cursor: string | null;
  };
}

interface CatalogItem {
  id: string;
  kind: MediaKind;
  title: string;
  canonical_source_url: string | null;
  processing_status: string;
  created_at: string;
  updated_at: string;
}

const KIND_LABEL: Record<MediaKind, string> = {
  web_article: "Web Article",
  epub: "EPUB",
  pdf: "PDF",
  podcast_episode: "Podcast Episode",
  video: "Video",
};

function isMediaKind(kind: string): kind is MediaKind {
  return (
    kind === "web_article" ||
    kind === "epub" ||
    kind === "pdf" ||
    kind === "podcast_episode" ||
    kind === "video"
  );
}

function toTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDate(value: string): string {
  const timestamp = toTimestamp(value);
  if (timestamp === 0) {
    return "unknown date";
  }
  return new Date(timestamp).toLocaleDateString();
}

function statusVariant(
  status: string
): "success" | "info" | "warning" | "danger" | "neutral" {
  if (status === "ready" || status === "ready_for_reading") {
    return "success";
  }
  if (status === "extracting" || status === "embedding") {
    return "info";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "pending") {
    return "warning";
  }
  return "neutral";
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export default function MediaCatalogPage({
  title,
  description,
  allowedKinds,
  emptyMessage,
  headerSlot,
  onDeleteItem,
}: MediaCatalogPageProps) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const allowedKindsKey = useMemo(
    () => [...allowedKinds].sort().join(","),
    [allowedKinds]
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          limit: "100",
          kind: allowedKindsKey,
        });
        const response = await apiFetch<MediaListResponse>(`/api/media?${params.toString()}`);
        const nextItems = response.data
          .filter((item) => isMediaKind(item.kind))
          .map((item) => ({
            id: item.id,
            kind: item.kind as MediaKind,
            title: item.title,
            canonical_source_url: item.canonical_source_url,
            processing_status: item.processing_status,
            created_at: item.created_at,
            updated_at: item.updated_at,
          }));

        if (!cancelled) {
          setItems(nextItems);
          setNextCursor(response.page.next_cursor);
        }
      } catch (loadError) {
        if (!cancelled) {
          if (isApiError(loadError)) {
            setError(loadError.message);
          } else {
            setError(`Failed to load ${title.toLowerCase()}`);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [allowedKindsKey, title]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) {
      return;
    }

    setLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: "100",
        kind: allowedKindsKey,
        cursor: nextCursor,
      });
      const response = await apiFetch<MediaListResponse>(`/api/media?${params.toString()}`);
      const nextItems = response.data
        .filter((item) => isMediaKind(item.kind))
        .map((item) => ({
          id: item.id,
          kind: item.kind as MediaKind,
          title: item.title,
          canonical_source_url: item.canonical_source_url,
          processing_status: item.processing_status,
          created_at: item.created_at,
          updated_at: item.updated_at,
        }));
      setItems((prev) => [...prev, ...nextItems]);
      setNextCursor(response.page.next_cursor);
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError(`Failed to load more ${title.toLowerCase()}`);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [allowedKindsKey, loadingMore, nextCursor, title]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return items;
    }

    return items.filter((item) => {
      const inTitle = item.title.toLowerCase().includes(normalizedQuery);
      const inSource = (item.canonical_source_url ?? "").toLowerCase().includes(normalizedQuery);
      return inTitle || inSource;
    });
  }, [items, query]);

  return (
    <PageLayout title={title} description={description}>
      {headerSlot}

      <SectionCard
        title="Catalog"
        actions={
          <span className={styles.count}>
            {filteredItems.length} {filteredItems.length === 1 ? "item" : "items"}
          </span>
        }
      >
        <div className={styles.toolbar}>
          <input
            className={styles.input}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${title.toLowerCase()}...`}
            aria-label={`Filter ${title}`}
          />
        </div>

        {error && <StateMessage variant="error">{error}</StateMessage>}

        {loading ? (
          <StateMessage variant="loading">Loading...</StateMessage>
        ) : filteredItems.length === 0 ? (
          <StateMessage variant="empty">
            {query.trim() ? "No items match this filter." : emptyMessage}
          </StateMessage>
        ) : (
          <AppList>
            {filteredItems.map((item) => (
              <AppListItem
                key={item.id}
                href={`/media/${item.id}`}
                icon={<MediaKindIcon kind={item.kind} />}
                title={item.title}
                description={KIND_LABEL[item.kind]}
                meta={`Updated ${formatDate(item.updated_at)}`}
                trailing={
                  <StatusPill variant={statusVariant(item.processing_status)}>
                    {statusLabel(item.processing_status)}
                  </StatusPill>
                }
                options={
                  onDeleteItem
                    ? [
                        {
                          id: "delete",
                          label: "Delete",
                          tone: "danger",
                          onSelect: () => onDeleteItem(item.id),
                        },
                      ]
                    : undefined
                }
              />
            ))}
          </AppList>
        )}

        {!loading && !query.trim() && nextCursor && (
          <button
            type="button"
            className={styles.loadMoreBtn}
            onClick={handleLoadMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
            aria-live="polite"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        )}
      </SectionCard>
    </PageLayout>
  );
}
