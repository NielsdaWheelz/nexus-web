/**
 * Search page — keyword search across visible content.
 *
 * Per s3_pr07 §8:
 * - Query input + type filters (media/podcast/content_chunk/note_block/message)
 * - Results list with type badge, snippet, click navigation
 * - media/content_chunk → /media/:id; note_block → /notes/:id
 * - message → /conversations/:conversationId
 */

"use client";

import { useState, useCallback, useEffect, useMemo, useRef, type FormEvent } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SectionCard from "@/components/ui/SectionCard";
import ContributorFilter from "@/components/contributors/ContributorFilter";
import SearchResultRow from "@/components/search/SearchResultRow";
import {
  ALL_SEARCH_TYPES,
  fetchSearchResultPage,
  type SearchResultRowViewModel,
  type SearchType,
} from "@/lib/search/resultRowAdapter";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

// ============================================================================
// Component
// ============================================================================

const SEARCH_TYPE_LABELS: Record<SearchType, string> = {
  contributor: "Authors",
  media: "Media",
  podcast: "Podcasts",
  content_chunk: "Evidence",
  page: "Pages",
  note_block: "Notes",
  message: "Messages",
};

const SEARCH_ROLE_FILTERS = [
  ["author", "Authors"],
  ["editor", "Editors"],
  ["translator", "Translators"],
  ["host", "Hosts"],
  ["guest", "Guests"],
  ["narrator", "Narrators"],
  ["creator", "Creators"],
  ["producer", "Producers"],
  ["channel", "Channels"],
] as const;

const SEARCH_CONTENT_KIND_FILTERS = [
  ["web_article", "Articles"],
  ["pdf", "PDFs"],
  ["epub", "EPUBs"],
  ["video", "Videos"],
  ["podcast_episode", "Episodes"],
  ["podcast", "Podcasts"],
] as const;

function isSearchType(value: string): value is SearchType {
  return ALL_SEARCH_TYPES.includes(value as SearchType);
}

function parseSelectedTypes(searchParams: URLSearchParams): SearchType[] {
  if (!searchParams.has("types")) {
    return [...ALL_SEARCH_TYPES];
  }
  const raw = searchParams.getAll("types").join(",");
  if (raw === "") {
    return [];
  }
  const seen = new Set<SearchType>();
  for (const part of raw.split(",")) {
    if (isSearchType(part) && !seen.has(part)) {
      seen.add(part);
    }
  }
  return ALL_SEARCH_TYPES.filter((type) => seen.has(type));
}

function parseCommaList(searchParams: URLSearchParams, key: string): string[] {
  const raw = searchParams.getAll(key).join(",");
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const part of raw.split(",")) {
    const handle = part.trim();
    if (!handle || seen.has(handle)) {
      continue;
    }
    seen.add(handle);
    handles.push(handle);
  }
  return handles;
}

function parseContributorHandles(searchParams: URLSearchParams): string[] {
  return parseCommaList(searchParams, "contributor_handles");
}

function buildSearchHref({
  query,
  types,
  contributorHandles,
  roles,
  contentKinds,
}: {
  query: string;
  types: SearchType[];
  contributorHandles: string[];
  roles: string[];
  contentKinds: string[];
}): string {
  const params = new URLSearchParams();
  const trimmedQuery = query.trim();
  if (trimmedQuery) {
    params.set("q", trimmedQuery);
  }
  if (types.length === 0) {
    params.set("types", "");
  } else if (types.length < ALL_SEARCH_TYPES.length) {
    params.set("types", types.join(","));
  }
  if (contributorHandles.length > 0) {
    params.set("contributor_handles", contributorHandles.join(","));
  }
  if (roles.length > 0) {
    params.set("roles", roles.join(","));
  }
  if (contentKinds.length > 0) {
    params.set("content_kinds", contentKinds.join(","));
  }
  const search = params.toString();
  return search ? `/search?${search}` : "/search";
}

function toggleValue(current: string[], value: string): string[] {
  if (current.includes(value)) {
    return current.filter((candidate) => candidate !== value);
  }
  return [...current, value].filter(
    (candidate, index, values) => values.indexOf(candidate) === index
  );
}

export default function SearchPaneBody() {
  const paneRouter = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();
  const appliedQuery = paneSearchParams.get("q")?.trim() ?? "";
  const selectedTypes = useMemo(
    () => parseSelectedTypes(paneSearchParams),
    [paneSearchParams]
  );
  const selectedTypeSet = useMemo(() => new Set(selectedTypes), [selectedTypes]);
  const contributorHandles = useMemo(
    () => parseContributorHandles(paneSearchParams),
    [paneSearchParams]
  );
  const roles = useMemo(
    () => parseCommaList(paneSearchParams, "roles"),
    [paneSearchParams]
  );
  const roleSet = useMemo(() => new Set(roles), [roles]);
  const contentKinds = useMemo(
    () => parseCommaList(paneSearchParams, "content_kinds"),
    [paneSearchParams]
  );
  const contentKindSet = useMemo(() => new Set(contentKinds), [contentKinds]);
  const [draftQuery, setDraftQuery] = useState(appliedQuery);
  const [results, setResults] = useState<SearchResultRowViewModel[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const requestIdRef = useRef(0);

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  useEffect(() => {
    setDraftQuery(appliedQuery);
  }, [appliedQuery]);

  const search = useCallback(
    async (cursor?: string) => {
      if (
        !appliedQuery &&
        contributorHandles.length === 0 &&
        roles.length === 0 &&
        contentKinds.length === 0
      ) {
        return;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setSearching(true);
      setError(null);

      try {
        const page = await fetchSearchResultPage({
          query: appliedQuery,
          selectedTypes: selectedTypeSet,
          contributorHandles,
          roles,
          contentKinds,
          limit: 20,
          cursor: cursor ?? null,
        });

        if (requestId !== requestIdRef.current) return;
        if (cursor) {
          setResults((prev) => [...prev, ...page.rows]);
        } else {
          setResults(page.rows);
        }
        setNextCursor(page.nextCursor);
        setHasSearched(true);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(toFeedback(err, { fallback: "Search failed" }));
      } finally {
        if (requestId === requestIdRef.current) {
          setSearching(false);
        }
      }
    },
    [appliedQuery, contentKinds, contributorHandles, roles, selectedTypeSet]
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    paneRouter.replace(
      buildSearchHref({
        query: draftQuery,
        types: selectedTypes,
        contributorHandles,
        roles,
        contentKinds,
      })
    );
  };

  const toggleType = (type: SearchType) => {
    const next = selectedTypeSet.has(type)
      ? selectedTypes.filter((candidate) => candidate !== type)
      : [...selectedTypes, type].filter(
          (value, index, values) => values.indexOf(value) === index
        );
    paneRouter.replace(
      buildSearchHref({
        query: draftQuery,
        types: ALL_SEARCH_TYPES.filter((candidate) => next.includes(candidate)),
        contributorHandles,
        roles,
        contentKinds,
      })
    );
  };

  const handleContributorFilterChange = (nextContributorHandles: string[]) => {
    paneRouter.replace(
      buildSearchHref({
        query: draftQuery,
        types: selectedTypes,
        contributorHandles: nextContributorHandles,
        roles,
        contentKinds,
      })
    );
  };

  const handleRoleToggle = (role: string) => {
    paneRouter.replace(
      buildSearchHref({
        query: draftQuery,
        types: selectedTypes,
        contributorHandles,
        roles: toggleValue(roles, role),
        contentKinds,
      })
    );
  };

  const handleContentKindToggle = (contentKind: string) => {
    paneRouter.replace(
      buildSearchHref({
        query: draftQuery,
        types: selectedTypes,
        contributorHandles,
        roles,
        contentKinds: toggleValue(contentKinds, contentKind),
      })
    );
  };

  useEffect(() => {
    // Query/filter edits invalidate the previous cursor window.
    requestIdRef.current += 1;
    setResults([]);
    setNextCursor(null);
    setHasSearched(false);
    setError(null);
    if (
      appliedQuery ||
      contributorHandles.length > 0 ||
      roles.length > 0 ||
      contentKinds.length > 0
    ) {
      void search();
    }
  }, [appliedQuery, contentKinds, contributorHandles, roles, search, selectedTypes]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <SectionCard>
      <div className={styles.content}>
        <form className={styles.searchForm} onSubmit={handleSubmit}>
          <div className={styles.searchRow}>
            <input
              aria-label="Search content"
              className={styles.searchInput}
              type="text"
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="Search your Nexus content..."
              autoFocus
            />
            <button
              type="submit"
              className={styles.searchBtn}
              disabled={
                searching ||
                (!draftQuery.trim() &&
                  contributorHandles.length === 0 &&
                  roles.length === 0 &&
                  contentKinds.length === 0)
              }
            >
              {searching ? "..." : "Search"}
            </button>
          </div>

          <fieldset className={styles.filters}>
            <legend className="sr-only">Result types</legend>
            {ALL_SEARCH_TYPES.map((type) => (
              <label key={type} className={styles.filterLabel}>
                <input
                  type="checkbox"
                  checked={selectedTypeSet.has(type)}
                  onChange={() => toggleType(type)}
                />
                {SEARCH_TYPE_LABELS[type]}
              </label>
            ))}
          </fieldset>

          <ContributorFilter
            selectedHandles={contributorHandles}
            onChange={handleContributorFilterChange}
          />

          <fieldset className={styles.filters}>
            <legend className="sr-only">Contributor roles</legend>
            {SEARCH_ROLE_FILTERS.map(([role, label]) => (
              <label key={role} className={styles.filterLabel}>
                <input
                  type="checkbox"
                  checked={roleSet.has(role)}
                  onChange={() => handleRoleToggle(role)}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <fieldset className={styles.filters}>
            <legend className="sr-only">Content kinds</legend>
            {SEARCH_CONTENT_KIND_FILTERS.map(([contentKind, label]) => (
              <label key={contentKind} className={styles.filterLabel}>
                <input
                  type="checkbox"
                  checked={contentKindSet.has(contentKind)}
                  onChange={() => handleContentKindToggle(contentKind)}
                />
                {label}
              </label>
            ))}
          </fieldset>
        </form>

        {error ? <FeedbackNotice feedback={error} /> : null}

        {!hasSearched && (
          <FeedbackNotice severity="info">
            Enter a query or choose filters to search content already in Nexus.
          </FeedbackNotice>
        )}

        {hasSearched && results.length === 0 && !searching && (
          <FeedbackNotice severity="neutral">No results found.</FeedbackNotice>
        )}

        {searching && <FeedbackNotice severity="info">Searching...</FeedbackNotice>}

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
