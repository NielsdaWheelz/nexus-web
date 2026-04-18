"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import LibraryTargetPicker, {
  type LibraryTargetPickerItem,
} from "@/components/LibraryTargetPicker";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import { BookOpen, FileText, Globe, Mic, Video } from "lucide-react";
import styles from "./MediaCatalogPage.module.css";

const MEDIA_KIND_ICONS: Record<string, typeof Globe> = {
  podcast_episode: Mic,
  video: Video,
  epub: BookOpen,
  pdf: FileText,
};

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
  const [librariesByMediaId, setLibrariesByMediaId] = useState<
    Record<string, LibraryTargetPickerItem[]>
  >({});
  const [loadingLibraryMediaIds, setLoadingLibraryMediaIds] = useState<Set<string>>(
    new Set()
  );
  const [busyMembershipKeys, setBusyMembershipKeys] = useState<Set<string>>(new Set());
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
        if (cancelled) {
          return;
        }
        setItems(
          response.data
            .filter((item) => isMediaKind(item.kind))
            .map((item) => ({
              id: item.id,
              kind: item.kind as MediaKind,
              title: item.title,
              canonical_source_url: item.canonical_source_url,
              processing_status: item.processing_status,
              created_at: item.created_at,
              updated_at: item.updated_at,
            }))
        );
        setNextCursor(response.page.next_cursor);
        setLibrariesByMediaId({});
        setLoadingLibraryMediaIds(new Set());
        setBusyMembershipKeys(new Set());
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        if (isApiError(loadError)) {
          setError(loadError.message);
        } else {
          setError(`Failed to load ${title.toLowerCase()}`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

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
      setItems((prev) => [
        ...prev,
        ...response.data
          .filter((item) => isMediaKind(item.kind))
          .map((item) => ({
            id: item.id,
            kind: item.kind as MediaKind,
            title: item.title,
            canonical_source_url: item.canonical_source_url,
            processing_status: item.processing_status,
            created_at: item.created_at,
            updated_at: item.updated_at,
          })),
      ]);
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
      const inSource = (item.canonical_source_url ?? "")
        .toLowerCase()
        .includes(normalizedQuery);
      return inTitle || inSource;
    });
  }, [items, query]);

  const loadLibrariesForMedia = useCallback(
    async (mediaId: string) => {
      if (loadingLibraryMediaIds.has(mediaId) || librariesByMediaId[mediaId]) {
        return;
      }

      setLoadingLibraryMediaIds((prev) => new Set(prev).add(mediaId));
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
        }>(`/api/media/${mediaId}/libraries`);
        setLibrariesByMediaId((prev) => ({
          ...prev,
          [mediaId]: response.data.map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color,
            isInLibrary: library.is_in_library,
            canAdd: library.can_add,
            canRemove: library.can_remove,
          })),
        }));
      } catch (loadError) {
        if (isApiError(loadError)) {
          setError(loadError.message);
        } else {
          setError(`Failed to load ${title.toLowerCase()} libraries`);
        }
      } finally {
        setLoadingLibraryMediaIds((prev) => {
          const next = new Set(prev);
          next.delete(mediaId);
          return next;
        });
      }
    },
    [librariesByMediaId, loadingLibraryMediaIds, title]
  );

  const handleAddToLibrary = useCallback(
    async (mediaId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${mediaId}`;
      setBusyMembershipKeys((prev) => new Set(prev).add(busyKey));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/media`, {
          method: "POST",
          body: JSON.stringify({ media_id: mediaId }),
        });
        setLibrariesByMediaId((prev) => ({
          ...prev,
          [mediaId]: (prev[mediaId] ?? []).map((library) =>
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
      } catch (mutationError) {
        if (isApiError(mutationError)) {
          setError(mutationError.message);
        } else {
          setError(`Failed to add item to ${title.toLowerCase()} library`);
        }
      } finally {
        setBusyMembershipKeys((prev) => {
          const next = new Set(prev);
          next.delete(busyKey);
          return next;
        });
      }
    },
    [title]
  );

  const handleRemoveFromLibrary = useCallback(
    async (mediaId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${mediaId}`;
      setBusyMembershipKeys((prev) => new Set(prev).add(busyKey));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/media/${mediaId}`, {
          method: "DELETE",
        });
        setLibrariesByMediaId((prev) => ({
          ...prev,
          [mediaId]: (prev[mediaId] ?? []).map((library) =>
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
      } catch (mutationError) {
        if (isApiError(mutationError)) {
          setError(mutationError.message);
        } else {
          setError(`Failed to remove item from ${title.toLowerCase()} library`);
        }
      } finally {
        setBusyMembershipKeys((prev) => {
          const next = new Set(prev);
          next.delete(busyKey);
          return next;
        });
      }
    },
    [title]
  );

  return (
    <SectionCard>
      <div className={styles.content}>
        {headerSlot}

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
              const pickerLibraries = (librariesByMediaId[item.id] ?? []).map((library) => {
                const busyKey = `${library.id}:${item.id}`;
                if (!busyMembershipKeys.has(busyKey)) {
                  return library;
                }
                return {
                  ...library,
                  canAdd: false,
                  canRemove: false,
                };
              });

              return (
                <AppListItem
                  key={item.id}
                  href={`/media/${item.id}`}
                  icon={(() => {
                    const Icon = MEDIA_KIND_ICONS[item.kind] ?? Globe;
                    return <Icon size={18} aria-hidden="true" />;
                  })()}
                  title={item.title}
                  status={statusVariant(item.processing_status)}
                  meta={[KIND_LABEL[item.kind], `Updated ${formatDate(item.updated_at)}`].join(
                    " · "
                  )}
                  actions={
                    <LibraryTargetPicker
                      label="Libraries"
                      libraries={pickerLibraries}
                      loading={loadingLibraryMediaIds.has(item.id)}
                      onOpen={() => {
                        void loadLibrariesForMedia(item.id);
                      }}
                      onAddToLibrary={(libraryId) => {
                        void handleAddToLibrary(item.id, libraryId);
                      }}
                      onRemoveFromLibrary={(libraryId) => {
                        void handleRemoveFromLibrary(item.id, libraryId);
                      }}
                      emptyMessage="No non-default libraries available."
                    />
                  }
                  options={
                    item.canonical_source_url
                      ? [
                          {
                            id: "open-source",
                            label: "Open source",
                            href: item.canonical_source_url,
                          },
                        ]
                      : undefined
                  }
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
      </div>
    </SectionCard>
  );
}
