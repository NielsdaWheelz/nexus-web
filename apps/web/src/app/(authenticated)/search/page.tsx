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
import SearchResultRow from "@/components/search/SearchResultRow";
import {
  ALL_SEARCH_TYPES,
  adaptSearchResultRow,
  buildSearchQueryParams,
  isValidSearchResult,
  type SearchApiResult,
  type SearchResponseShape,
  type SearchType,
} from "@/lib/search/resultRowAdapter";
import styles from "./page.module.css";

// ============================================================================
// Component
// ============================================================================

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<Set<SearchType>>(new Set(ALL_SEARCH_TYPES));
  const [results, setResults] = useState<SearchApiResult[]>([]);
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
        const params = buildSearchQueryParams({
          query: trimmed,
          selectedTypes: types,
          limit: 20,
          cursor: cursor ?? null,
        });

        const response = await apiFetch<SearchResponseShape>(
          `/api/search?${params.toString()}`
        );

        // Layer 1: filter out structurally invalid results at the boundary
        const valid = response.results.filter((r) => {
          if (isValidSearchResult(r)) return true;
          console.warn("[search] dropping malformed result:", r);
          return false;
        });

        if (cursor) {
          setResults((prev) => [...prev, ...valid]);
        } else {
          setResults(valid);
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

  const toggleType = (type: SearchType) => {
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
            {ALL_SEARCH_TYPES.map((type) => (
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
          <div className={styles.resultRows}>
            {results.map((result) => (
              <SearchResultRow
                key={`${result.type}-${result.id}`}
                row={adaptSearchResultRow(result)}
              />
            ))}
          </div>
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
