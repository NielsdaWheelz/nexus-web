"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
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

interface LibrarySummary {
  id: string;
  name: string;
  is_default: boolean;
}

interface LibraryEntrySummary {
  kind: "media" | "podcast";
  media?: {
    id: string;
  } | null;
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
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [libraryIdsByMediaId, setLibraryIdsByMediaId] = useState<Record<string, string[]>>({});
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

        let nextLibraries: LibrarySummary[] = [];
        let nextLibraryIdsByMediaId: Record<string, string[]> = {};
        try {
          const librariesResponse = await apiFetch<{ data: LibrarySummary[] }>("/api/libraries");
          nextLibraries = librariesResponse.data.filter((library) => !library.is_default);
          if (nextLibraries.length > 0) {
            const entryResponses = await Promise.all(
              nextLibraries.map((library) =>
                apiFetch<{ data: LibraryEntrySummary[] }>(`/api/libraries/${library.id}/entries`)
              )
            );
            for (let index = 0; index < nextLibraries.length; index += 1) {
              const library = nextLibraries[index];
              const entries = entryResponses[index].data;
              for (const entry of entries) {
                if (entry.kind !== "media" || !entry.media) {
                  continue;
                }
                const existingLibraryIds = nextLibraryIdsByMediaId[entry.media.id] ?? [];
                nextLibraryIdsByMediaId[entry.media.id] = [
                  ...existingLibraryIds,
                  library.id,
                ];
              }
            }
          }
        } catch {
          nextLibraries = [];
          nextLibraryIdsByMediaId = {};
        }

        if (!cancelled) {
          setItems(nextItems);
          setNextCursor(response.page.next_cursor);
          setLibraries(nextLibraries);
          setLibraryIdsByMediaId(nextLibraryIdsByMediaId);
          setBusyMembershipKeys(new Set());
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
    async (mediaId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${mediaId}`;
      setBusyMembershipKeys((prev) => new Set(prev).add(busyKey));
      setError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/media`, {
          method: "POST",
          body: JSON.stringify({ media_id: mediaId }),
        });
        setLibraryIdsByMediaId((prev) => {
          const next = { ...prev };
          const nextIds = new Set(next[mediaId] ?? []);
          nextIds.add(libraryId);
          next[mediaId] = [...nextIds];
          return next;
        });
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
        setLibraryIdsByMediaId((prev) => {
          const next = { ...prev };
          const nextIds = new Set(next[mediaId] ?? []);
          nextIds.delete(libraryId);
          if (nextIds.size === 0) {
            delete next[mediaId];
          } else {
            next[mediaId] = [...nextIds];
          }
          return next;
        });
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
              const libraryIds = new Set(libraryIdsByMediaId[item.id] ?? []);
              const options = [
                ...libraries.map((library) => {
                  const inLibrary = libraryIds.has(library.id);
                  const busyKey = `${library.id}:${item.id}`;
                  return {
                    id: `${inLibrary ? "remove" : "add"}-${library.id}`,
                    label: `${inLibrary ? "Remove from" : "Add to"} ${library.name}`,
                    disabled: busyMembershipKeys.has(busyKey),
                    onSelect: () => {
                      void (inLibrary
                        ? handleRemoveFromLibrary(item.id, library.id)
                        : handleAddToLibrary(item.id, library.id));
                    },
                  };
                }),
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
                  icon={(() => {
                    const Icon = MEDIA_KIND_ICONS[item.kind] ?? Globe;
                    return <Icon size={18} aria-hidden="true" />;
                  })()}
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
      </div>
    </SectionCard>
  );
}
