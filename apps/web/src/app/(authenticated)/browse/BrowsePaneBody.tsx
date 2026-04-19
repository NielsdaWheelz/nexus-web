"use client";

import { useCallback, useEffect, useState } from "react";
import { Mic, Play } from "lucide-react";
import LibraryTargetPicker, {
  type LibraryTargetPickerItem,
} from "@/components/LibraryTargetPicker";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { apiFetch, isApiError } from "@/lib/api/client";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import styles from "./page.module.css";

type BrowseType = "all" | "podcasts" | "podcast_episodes" | "videos" | "documents";

type BrowsePageResponse = {
  data: {
    results: BrowseResult[];
    page: {
      has_more: boolean;
      next_cursor: string | null;
    };
  };
};

type BrowsePodcastResult = {
  type: "podcasts";
  podcast_id: string | null;
  provider_podcast_id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
};

type BrowseEpisodeResult = {
  type: "podcast_episodes";
  podcast_id: string | null;
  provider_podcast_id: string;
  provider_episode_id: string;
  podcast_title: string;
  podcast_author: string | null;
  podcast_image_url: string | null;
  title: string;
  audio_url: string;
  published_at: string | null;
  duration_seconds: number | null;
  feed_url: string;
  website_url: string | null;
  description: string | null;
};

type BrowseResult = BrowsePodcastResult | BrowseEpisodeResult;

type LibrarySummary = {
  id: string;
  name: string;
  is_default: boolean;
  color?: string | null;
};

const FILTERS: Array<{ value: BrowseType; label: string }> = [
  { value: "all", label: "All" },
  { value: "podcasts", label: "Podcasts" },
  { value: "podcast_episodes", label: "Episodes" },
  { value: "videos", label: "Videos" },
  { value: "documents", label: "Documents" },
];

export default function BrowsePaneBody() {
  const [query, setQuery] = useState("");
  const [resultType, setResultType] = useState<BrowseType>("all");
  const [results, setResults] = useState<BrowseResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busyProviderIds, setBusyProviderIds] = useState<Set<string>>(new Set());
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [librariesLoaded, setLibrariesLoaded] = useState(false);

  const loadLibraries = useCallback(async () => {
    if (librariesLoading || librariesLoaded) {
      return;
    }
    setLibrariesLoading(true);
    try {
      const response = await apiFetch<{ data: LibrarySummary[] }>("/api/libraries");
      setLibraries(
        response.data
          .filter((library) => !library.is_default)
          .map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color ?? null,
            isInLibrary: false,
            canAdd: true,
            canRemove: false,
          }))
      );
      setLibrariesLoaded(true);
    } finally {
      setLibrariesLoading(false);
    }
  }, [librariesLoaded, librariesLoading]);

  const search = useCallback(
    async (cursor?: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        return;
      }
      setSearching(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          q: trimmed,
          type: resultType,
          limit: "20",
        });
        if (cursor) {
          params.set("cursor", cursor);
        }
        const response = await apiFetch<BrowsePageResponse>(`/api/browse?${params.toString()}`);
        const nextResults = response.data.results;
        setResults((current) => (cursor ? [...current, ...nextResults] : nextResults));
        setNextCursor(response.data.page.next_cursor);
        setHasSearched(true);
      } catch (searchError) {
        if (isApiError(searchError)) {
          setError(searchError.message);
        } else {
          setError("Browse failed");
        }
      } finally {
        setSearching(false);
      }
    },
    [query, resultType]
  );

  useEffect(() => {
    setResults([]);
    setNextCursor(null);
    setHasSearched(false);
    setError(null);
  }, [query, resultType]);

  const ensureAndOpenPodcast = useCallback(async (result: BrowsePodcastResult | BrowseEpisodeResult) => {
    if (result.podcast_id) {
      requestOpenInAppPane(`/podcasts/${result.podcast_id}`);
      return;
    }
    setBusyProviderIds((current) => new Set(current).add(result.provider_podcast_id));
    try {
      const response = await apiFetch<{ data: { podcast_id: string } }>("/api/podcasts/ensure", {
        method: "POST",
        body: JSON.stringify({
          provider_podcast_id: result.provider_podcast_id,
          title: result.type === "podcasts" ? result.title : result.podcast_title,
          author: result.type === "podcasts" ? result.author : result.podcast_author,
          feed_url: result.feed_url,
          website_url: result.website_url,
          image_url: result.type === "podcasts" ? result.image_url : result.podcast_image_url,
          description: result.description,
        }),
      });
      const podcastId = response.data.podcast_id;
      setResults((current) =>
        current.map((row) =>
          row.provider_podcast_id === result.provider_podcast_id
            ? { ...row, podcast_id: podcastId }
            : row
        )
      );
      requestOpenInAppPane(`/podcasts/${podcastId}`);
    } catch (openError) {
      if (isApiError(openError)) {
        setError(openError.message);
      } else {
        setError("Failed to open podcast");
      }
    } finally {
      setBusyProviderIds((current) => {
        const next = new Set(current);
        next.delete(result.provider_podcast_id);
        return next;
      });
    }
  }, []);

  const followPodcast = useCallback(
    async (result: BrowsePodcastResult, libraryId: string | null = null) => {
      setBusyProviderIds((current) => new Set(current).add(result.provider_podcast_id));
      setError(null);
      try {
        const response = await apiFetch<{ data: { podcast_id: string } }>("/api/podcasts/subscriptions", {
          method: "POST",
          body: JSON.stringify({
            provider_podcast_id: result.provider_podcast_id,
            title: result.title,
            author: result.author,
            feed_url: result.feed_url,
            website_url: result.website_url,
            image_url: result.image_url,
            description: result.description,
            library_id: libraryId,
          }),
        });
        setResults((current) =>
          current.map((row) =>
            row.type === "podcasts" && row.provider_podcast_id === result.provider_podcast_id
              ? { ...row, podcast_id: response.data.podcast_id }
              : row
          )
        );
      } catch (followError) {
        if (isApiError(followError)) {
          setError(followError.message);
        } else {
          setError("Failed to follow podcast");
        }
      } finally {
        setBusyProviderIds((current) => {
          const next = new Set(current);
          next.delete(result.provider_podcast_id);
          return next;
        });
      }
    },
    []
  );

  return (
    <SectionCard>
      <div className={styles.content}>
        <form
          className={styles.searchForm}
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search for new podcasts, episodes, videos, or documents..."
              autoFocus
            />
            <button
              type="submit"
              className={styles.searchBtn}
              disabled={searching || !query.trim()}
            >
              {searching ? "..." : "Search"}
            </button>
          </div>

          <div className={styles.filters} role="tablist" aria-label="Browse result type">
            {FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                role="tab"
                aria-selected={resultType === filter.value}
                className={resultType === filter.value ? styles.filterActive : styles.filter}
                onClick={() => setResultType(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </form>

        {error ? <StateMessage variant="error">{error}</StateMessage> : null}

        {!hasSearched ? (
          <StateMessage variant="info">
            Search globally, then narrow the results by type. Browse finds things that are not already in your workspace.
          </StateMessage>
        ) : null}

        {searching ? <StateMessage variant="loading">Searching...</StateMessage> : null}

        {hasSearched && !searching && results.length === 0 ? (
          <StateMessage variant="empty">
            No browse results found for this query and type.
          </StateMessage>
        ) : null}

        {results.length > 0 ? (
          <div className={styles.resultRows}>
            {results.map((result) => {
              if (result.type === "podcasts") {
                const busy = busyProviderIds.has(result.provider_podcast_id);
                return (
                  <div key={`podcast-${result.provider_podcast_id}`} className={styles.row}>
                    <button
                      type="button"
                      className={styles.primary}
                      onClick={() => {
                        void ensureAndOpenPodcast(result);
                      }}
                    >
                      <div className={styles.leading}>
                        {result.image_url ? (
                          <img src={result.image_url} alt="" className={styles.artwork} />
                        ) : (
                          <span className={styles.fallback} aria-hidden="true">
                            <Mic size={18} />
                          </span>
                        )}
                      </div>
                      <div className={styles.copy}>
                        <div className={styles.headingRow}>
                          <span className={styles.typeBadge}>Podcast</span>
                          {result.author ? <span className={styles.meta}>{result.author}</span> : null}
                        </div>
                        <div className={styles.title}>{result.title}</div>
                        <div className={styles.description}>
                          {result.description || "Open the show page or follow it from browse."}
                        </div>
                      </div>
                    </button>
                    <div className={styles.actions}>
                      {result.podcast_id ? (
                        <button
                          type="button"
                          className={styles.primaryAction}
                          disabled={busy}
                          onClick={() => {
                            void ensureAndOpenPodcast(result);
                          }}
                        >
                          {busy ? "Opening..." : "Open"}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={styles.primaryAction}
                            disabled={busy}
                            onClick={() => {
                              void followPodcast(result);
                            }}
                          >
                            {busy ? "Following..." : "Follow"}
                          </button>
                          <LibraryTargetPicker
                            label="Follow + library"
                            libraries={libraries}
                            loading={librariesLoading}
                            disabled={busy}
                            onOpen={() => {
                              void loadLibraries();
                            }}
                            onSelectLibrary={(libraryId) => {
                              void followPodcast(result, libraryId);
                            }}
                            emptyMessage="No non-default libraries available."
                          />
                        </>
                      )}
                    </div>
                  </div>
                );
              }

              const busy = busyProviderIds.has(result.provider_podcast_id);
              return (
                <div key={`episode-${result.provider_episode_id}`} className={styles.row}>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => {
                      void ensureAndOpenPodcast(result);
                    }}
                  >
                    <div className={styles.leading}>
                      {result.podcast_image_url ? (
                        <img src={result.podcast_image_url} alt="" className={styles.artwork} />
                      ) : (
                        <span className={styles.fallback} aria-hidden="true">
                          <Play size={18} />
                        </span>
                      )}
                    </div>
                    <div className={styles.copy}>
                      <div className={styles.headingRow}>
                        <span className={styles.typeBadge}>Episode</span>
                        <span className={styles.meta}>{result.podcast_title}</span>
                      </div>
                      <div className={styles.title}>{result.title}</div>
                      <div className={styles.description}>
                        {result.published_at ? `Published ${new Date(result.published_at).toLocaleDateString()}` : "Recent episode preview"}
                        {result.duration_seconds ? ` · ${Math.round(result.duration_seconds / 60)} min` : ""}
                      </div>
                    </div>
                  </button>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.primaryAction}
                      disabled={busy}
                      onClick={() => {
                        void ensureAndOpenPodcast(result);
                      }}
                    >
                      {busy ? "Opening..." : "Open show"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {nextCursor ? (
          <button
            type="button"
            className={styles.loadMore}
            onClick={() => {
              void search(nextCursor);
            }}
            disabled={searching}
          >
            Load more
          </button>
        ) : null}
      </div>
    </SectionCard>
  );
}
