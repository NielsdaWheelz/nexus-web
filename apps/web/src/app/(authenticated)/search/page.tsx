/**
 * Search page — keyword search across visible content.
 *
 * Per s3_pr07 §8:
 * - Query input + type filters (media/fragment/annotation/message)
 * - Results list with type badge, snippet, click navigation
 * - media/fragment/annotation → /media/:id
 * - message → /conversations/:conversationId
 */

"use client";

import { useState, useCallback } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import PageLayout from "@/components/ui/PageLayout";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

// ============================================================================
// Types
// ============================================================================

interface SearchResult {
  type: "media" | "fragment" | "annotation" | "message";
  id: string;
  score: number;
  snippet: string;
  title?: string | null;
  media_id?: string | null;
  idx?: number | null;
  highlight_id?: string | null;
  conversation_id?: string | null;
  seq?: number | null;
}

interface SearchResponse {
  results: SearchResult[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

const ALL_TYPES = ["media", "fragment", "annotation", "message"] as const;

// ============================================================================
// Component
// ============================================================================

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<Set<string>>(new Set(ALL_TYPES));
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  const search = useCallback(
    async (cursor?: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;

      setSearching(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          q: trimmed,
          limit: "20",
        });
        if (types.size > 0 && types.size < ALL_TYPES.length) {
          params.set("types", Array.from(types).join(","));
        }
        if (cursor) {
          params.set("cursor", cursor);
        }

        const response = await apiFetch<SearchResponse>(
          `/api/search?${params}`
        );

        if (cursor) {
          setResults((prev) => [...prev, ...response.results]);
        } else {
          setResults(response.results);
        }
        setNextCursor(response.page.next_cursor);
        setHasSearched(true);
      } catch (err) {
        if (isApiError(err)) {
          setError(err.message);
        } else {
          setError("Search failed");
        }
      } finally {
        setSearching(false);
      }
    },
    [query, types]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    search();
  };

  const toggleType = (type: string) => {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // --------------------------------------------------------------------------
  // Result navigation URL
  // --------------------------------------------------------------------------

  function getResultHref(result: SearchResult): string {
    switch (result.type) {
      case "media":
        return `/media/${result.id}`;
      case "fragment":
        return result.media_id ? `/media/${result.media_id}` : "#";
      case "annotation":
        return result.media_id ? `/media/${result.media_id}` : "#";
      case "message":
        return result.conversation_id
          ? `/conversations/${result.conversation_id}`
          : "#";
      default:
        return "#";
    }
  }

  function getResultDescription(result: SearchResult): string {
    switch (result.type) {
      case "media":
        return result.title || "Untitled";
      case "fragment":
        return `Fragment ${result.idx ?? "?"} of media`;
      case "annotation":
        return `Annotation on highlight`;
      case "message":
        return `Message #${result.seq ?? "?"} in conversation`;
      default:
        return "";
    }
  }

  function getTypeVariant(type: SearchResult["type"]) {
    if (type === "media") return "info";
    if (type === "fragment") return "success";
    if (type === "annotation") return "warning";
    return "neutral";
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <PageLayout
      title="Search"
      description="Keyword search across media, fragments, annotations, and chat messages."
    >
      <SectionCard title="Query">
        <form className={styles.searchForm} onSubmit={handleSubmit}>
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your content..."
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

          <div className={styles.filters}>
            {ALL_TYPES.map((type) => (
              <label key={type} className={styles.filterLabel}>
                <input
                  type="checkbox"
                  checked={types.has(type)}
                  onChange={() => toggleType(type)}
                />
                {type}
              </label>
            ))}
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title="Results"
        actions={
          searching ? <span className={styles.searchingHint}>Searching...</span> : null
        }
      >
        {error && <StateMessage variant="error">{error}</StateMessage>}

        {!hasSearched && (
          <StateMessage variant="info">
            Enter a query to search across your media, annotations, and conversations.
          </StateMessage>
        )}

        {hasSearched && results.length === 0 && !searching && (
          <StateMessage variant="empty">No results found.</StateMessage>
        )}

        {results.length > 0 && (
          <AppList>
            {results.map((result) => (
              <AppListItem
                key={`${result.type}-${result.id}`}
                href={getResultHref(result)}
                title={getResultDescription(result)}
                description={result.snippet || "No snippet available"}
                meta={`score ${result.score.toFixed(2)}`}
                trailing={
                  <StatusPill variant={getTypeVariant(result.type)}>
                    {result.type}
                  </StatusPill>
                }
              />
            ))}
          </AppList>
        )}

        {nextCursor && (
          <button
            className={styles.loadMore}
            onClick={() => search(nextCursor)}
            disabled={searching}
          >
            Load more
          </button>
        )}
      </SectionCard>
    </PageLayout>
  );
}
