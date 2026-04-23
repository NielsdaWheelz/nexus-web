/**
 * Search page — keyword search across visible content.
 *
 * Per s3_pr07 §8:
 * - Query input + type filters (media/fragment/annotation/message/transcript_chunk)
 * - Results list with type badge, snippet, click navigation
 * - media/fragment/annotation → /media/:id
 * - message → /conversations/:conversationId
 * - transcript_chunk → /media/:id?t_start_ms=<timestamp>
 */

"use client";

import { useState, useCallback, useEffect } from "react";
import { isApiError } from "@/lib/api/client";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import SearchResultRow from "@/components/search/SearchResultRow";
import {
  ALL_SEARCH_TYPES,
  fetchSearchResultPage,
  type SearchResultRowViewModel,
  type SearchType,
} from "@/lib/search/resultRowAdapter";
import styles from "./page.module.css";

// ============================================================================
// Component
// ============================================================================

export default function SearchPaneBody() {
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<Set<SearchType>>(new Set(ALL_SEARCH_TYPES));
  const [results, setResults] = useState<SearchResultRowViewModel[]>([]);
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
        const page = await fetchSearchResultPage({
          query: trimmed,
          selectedTypes: types,
          limit: 20,
          cursor: cursor ?? null,
        });

        if (cursor) {
          setResults((prev) => [...prev, ...page.rows]);
        } else {
          setResults(page.rows);
        }
        setNextCursor(page.nextCursor);
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

  useEffect(() => {
    // Query/filter edits invalidate the previous cursor window.
    setResults([]);
    setNextCursor(null);
    setHasSearched(false);
    setError(null);
  }, [query, types]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <SectionCard>
      <div className={styles.content}>
        <form className={styles.searchForm} onSubmit={handleSubmit}>
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your Nexus content..."
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

        {error && <StateMessage variant="error">{error}</StateMessage>}

        {!hasSearched && (
          <StateMessage variant="info">
            Enter a query to search content already in Nexus, including media, annotations, transcript chunks, and conversations.
          </StateMessage>
        )}

        {hasSearched && results.length === 0 && !searching && (
          <StateMessage variant="empty">No results found.</StateMessage>
        )}

        {searching && <StateMessage variant="loading">Searching...</StateMessage>}

        {results.length > 0 && (
          <div className={styles.resultRows}>
            {results.map((result) => (
              <SearchResultRow key={result.key} row={result} />
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
      </div>
    </SectionCard>
  );
}
