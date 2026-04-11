"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
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
  allowedKinds: MediaKind[];
  emptyMessage: string;
  headerSlot?: React.ReactNode;
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

interface MeResponse {
  user_id: string;
  default_library_id: string | null;
}

interface LibraryMediaSummary {
  id: string;
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

const LIBRARY_MEDIA_PAGE_SIZE = 200;

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


export default function MediaCatalogPage({
  title,
  allowedKinds,
  emptyMessage,
  headerSlot,
}: MediaCatalogPageProps) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [defaultLibraryId, setDefaultLibraryId] = useState<string | null>(null);
  const [libraryMediaIds, setLibraryMediaIds] = useState<Set<string>>(new Set());
  const [busyMediaIds, setBusyMediaIds] = useState<Set<string>>(new Set());
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
        let nextDefaultLibraryId: string | null = null;
        let nextLibraryMediaIds = new Set<string>();

        try {
          const meResponse = await apiFetch<{ data: MeResponse }>("/api/me");
          nextDefaultLibraryId = meResponse.data.default_library_id;

          if (nextDefaultLibraryId) {
            let offset = 0;
            while (true) {
              const page = await apiFetch<{ data: LibraryMediaSummary[] }>(
                `/api/libraries/${nextDefaultLibraryId}/media?limit=${LIBRARY_MEDIA_PAGE_SIZE}&offset=${offset}`
              );
              for (const media of page.data) {
                nextLibraryMediaIds.add(media.id);
              }
              if (page.data.length < LIBRARY_MEDIA_PAGE_SIZE) {
                break;
              }
              offset += LIBRARY_MEDIA_PAGE_SIZE;
            }
          }
        } catch {
          nextDefaultLibraryId = null;
          nextLibraryMediaIds = new Set<string>();
        }

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
          setDefaultLibraryId(nextDefaultLibraryId);
          setLibraryMediaIds(nextLibraryMediaIds);
          setBusyMediaIds(new Set());
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
          setError(`Failed to add item to ${title.toLowerCase()} library`);
        }
      } finally {
        setBusyMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [defaultLibraryId, title]
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
          setError(`Failed to remove item from ${title.toLowerCase()} library`);
        }
      } finally {
        setBusyMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [defaultLibraryId, title]
  );

  return (
    <>
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
            {filteredItems.map((item) => {
              const inDefaultLibrary = libraryMediaIds.has(item.id);
              const isMutating = busyMediaIds.has(item.id);
              const options = [
                ...(defaultLibraryId
                  ? [
                      {
                        id: inDefaultLibrary ? "remove-from-library" : "add-to-library",
                        label: inDefaultLibrary ? "Remove from library" : "Add to library",
                        disabled: isMutating,
                        onSelect: () => {
                          void (inDefaultLibrary
                            ? handleRemoveFromLibrary(item.id)
                            : handleAddToLibrary(item.id));
                        },
                      },
                    ]
                  : []),
                ...(item.canonical_source_url
                  ? [
                      {
                        id: "open-source",
                        label: "Open source",
                        href: item.canonical_source_url,
                      },
                    ]
                  : []),
              ];

              return (
                <AppListItem
                  key={item.id}
                  href={`/media/${item.id}`}
                  icon={<MediaKindIcon kind={item.kind} />}
                  title={item.title}
                  status={statusVariant(item.processing_status)}
                  meta={[KIND_LABEL[item.kind], `Updated ${formatDate(item.updated_at)}`].join(" · ")}
                  options={options.length > 0 ? options : undefined}
                />
              );
            })}
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
    </>
  );
}
