/**
 * Search page — one box, six kind chips, operator-backed filter chips.
 *
 * Searches all kinds by default; refine after via the kind row, the "+ Format"
 * menu, the author picker, or typed operators (format:/author:/role:/in:). All
 * refinements render as removable chips. Hybrid retrieval is invisible.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SectionCard from "@/components/ui/SectionCard";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import ActionMenu from "@/components/ui/ActionMenu";
import ContributorFilter from "@/components/contributors/ContributorFilter";
import SearchResultRow from "@/components/search/SearchResultRow";
import KindChips from "@/components/search/KindChips";
import AppliedFilters, {
  type AppliedFilterChip,
} from "@/components/search/AppliedFilters";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchSearchResultPage } from "@/lib/search/searchApi";
import {
  MEDIA_FORMATS,
  MEDIA_FORMAT_LABELS,
  SEARCH_KINDS,
  disabledKinds,
  type MediaFormat,
  type SearchKind,
} from "@/lib/search/kinds";
import { parseSearchInput } from "@/lib/search/parseSearchInput";
import {
  applyParsedInput,
  hasActiveFilters,
  hasCreditFilter,
  hasFormatFilter,
  isBlankQuery,
  type SearchQuery,
} from "@/lib/search/query";
import {
  searchHref,
  searchQueryFromParams,
  searchQueryToParams,
} from "@/lib/search/searchParams";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_LIMIT = 20;

function queryKey(query: SearchQuery): string {
  return searchQueryToParams(query).toString();
}

export default function SearchPaneBody() {
  const paneRouter = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();

  const query = useMemo(
    () => searchQueryFromParams(paneSearchParams),
    [paneSearchParams],
  );
  const queryString = queryKey(query);

  const [draft, setDraft] = useState(query.text);
  const [results, setResults] = useState<SearchResultRowViewModel[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const requestIdRef = useRef(0);

  const replaceQuery = useCallback(
    (next: SearchQuery) => {
      paneRouter.replace(searchHref(next));
    },
    [paneRouter],
  );

  // Sync the box when the URL query text changes (chip removal, navigation).
  useEffect(() => {
    setDraft(query.text);
  }, [query.text]);

  // Debounced: parse the box, absorb completed operators into the query.
  useEffect(() => {
    const handle = setTimeout(() => {
      const parsed = parseSearchInput(draft);
      const merged = applyParsedInput(query, parsed);
      if (queryKey(merged) !== queryString) {
        replaceQuery(merged);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // query/queryString intentionally omitted: this effect reacts to box edits;
    // the equality guard prevents a replace loop when the URL already matches.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: URL query changes sync draft through the separate query.text effect; this debounce reacts only to box edits.
  }, [draft]);

  const runSearch = useCallback(
    async (cursor?: string) => {
      if (isBlankQuery(query)) {
        return;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setSearching(true);
      setError(null);
      try {
        const page = await fetchSearchResultPage(query, {
          limit: PAGE_LIMIT,
          cursor: cursor ?? null,
        });
        if (requestId !== requestIdRef.current) return;
        setResults((prev) => (cursor ? [...prev, ...page.rows] : page.rows));
        setNextCursor(page.nextCursor);
        setHasSearched(true);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        if (handleUnauthenticatedApiError(err)) return;
        setError(toFeedback(err, { fallback: "Search failed" }));
      } finally {
        if (requestId === requestIdRef.current) {
          setSearching(false);
        }
      }
    },
    [query],
  );

  // Re-run search whenever the effective query changes.
  useEffect(() => {
    requestIdRef.current += 1;
    setResults([]);
    setNextCursor(null);
    setHasSearched(false);
    setError(null);
    if (!isBlankQuery(query)) {
      void runSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: queryString is the canonical route-change key; runSearch captures the same parsed query for this render.
  }, [queryString]);

  const formatDisabled = hasFormatFilter(query);
  const creditDisabled = hasCreditFilter(query);
  const { kinds: disabledKindSet, reason: disabledReason } = disabledKinds({
    hasFormatFilter: formatDisabled,
    hasCreditFilter: creditDisabled,
  });

  const toggleKind = (kind: SearchKind) => {
    const active =
      query.requestedKinds === null
        ? new Set<SearchKind>(SEARCH_KINDS)
        : new Set(query.requestedKinds);
    if (active.has(kind)) {
      active.delete(kind);
    } else {
      active.add(kind);
    }
    const next = active.size === SEARCH_KINDS.length ? null : active;
    replaceQuery({ ...query, requestedKinds: next });
  };

  const toggleFormat = (format: MediaFormat) => {
    const next = query.formats.includes(format)
      ? query.formats.filter((value) => value !== format)
      : [...query.formats, format];
    replaceQuery({ ...query, formats: next });
  };

  const setAuthors = (authors: string[]) => {
    replaceQuery({ ...query, authors });
  };

  // Authors are owned by ContributorFilter (which resolves handles to display names);
  // the applied-filter bar carries the operator chips it doesn't own.
  const appliedChips: AppliedFilterChip[] = [
    ...query.formats.map((format) => ({
      id: `format:${format}`,
      label: MEDIA_FORMAT_LABELS[format],
    })),
    ...query.roles.map((role) => ({ id: `role:${role}`, label: `Role: ${role}` })),
    ...(query.scope !== "all"
      ? [{ id: `scope:${query.scope}`, label: `In: ${query.scope}` }]
      : []),
  ];

  const removeFilter = (id: string) => {
    const separator = id.indexOf(":");
    const dim = id.slice(0, separator);
    const value = id.slice(separator + 1);
    if (dim === "format") {
      replaceQuery({
        ...query,
        formats: query.formats.filter((format) => format !== value),
      });
    } else if (dim === "role") {
      replaceQuery({ ...query, roles: query.roles.filter((role) => role !== value) });
    } else if (dim === "scope") {
      replaceQuery({ ...query, scope: "all" });
    }
  };

  const clearAllFilters = () => {
    replaceQuery({
      text: query.text,
      requestedKinds: null,
      formats: [],
      authors: [],
      roles: [],
      scope: "all",
    });
  };

  const filtersActive = hasActiveFilters(query);

  return (
    <SectionCard>
      <div className={styles.content}>
        <div className={styles.searchForm}>
          <Input
            aria-label="Search content"
            className={styles.searchInputField}
            size="lg"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search your Nexus… (try format:pdf or author:le-guin)"
            autoFocus
          />

          <KindChips
            selected={query.requestedKinds}
            disabled={disabledKindSet}
            disabledReason={disabledReason}
            onToggle={toggleKind}
          />

          <div className={styles.refineRow}>
            <ActionMenu
              label="+ Format"
              options={MEDIA_FORMATS.map((format) => ({
                id: format,
                label: MEDIA_FORMAT_LABELS[format],
                onSelect: () => toggleFormat(format),
              }))}
            />
            <ContributorFilter
              selectedHandles={query.authors}
              onChange={setAuthors}
            />
          </div>

          <AppliedFilters
            chips={appliedChips}
            onRemove={removeFilter}
            onClearAll={clearAllFilters}
          />
        </div>

        {error ? <FeedbackNotice feedback={error} /> : null}

        {!hasSearched && !searching && (
          <FeedbackNotice severity="info">
            Search everything in your Nexus. Narrow with the kind chips or filters.
          </FeedbackNotice>
        )}

        {hasSearched && results.length === 0 && !searching && (
          <div className={styles.emptyResults}>
            <FeedbackNotice severity="neutral">No results found.</FeedbackNotice>
            {filtersActive && (
              <Button variant="secondary" size="md" onClick={clearAllFilters}>
                Clear filters
              </Button>
            )}
          </div>
        )}

        {searching && <FeedbackNotice severity="info">Searching…</FeedbackNotice>}

        {results.length > 0 && (
          <div className={styles.resultRows}>
            {results.map((result) => (
              <SearchResultRow key={result.key} row={result} />
            ))}
          </div>
        )}

        {nextCursor && (
          <Button
            variant="secondary"
            size="md"
            className={styles.loadMore}
            onClick={() => runSearch(nextCursor)}
            disabled={searching}
          >
            Load more
          </Button>
        )}
      </div>
    </SectionCard>
  );
}
