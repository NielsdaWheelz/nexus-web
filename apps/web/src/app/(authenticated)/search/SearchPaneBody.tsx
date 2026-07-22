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
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import ActionMenu from "@/components/ui/ActionMenu";
import CollectionView from "@/components/collections/CollectionView";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import ContributorFilter from "@/components/contributors/ContributorFilter";
import KindChips from "@/components/search/KindChips";
import AppliedFilters, {
  type AppliedFilterChip,
} from "@/components/search/AppliedFilters";
import { presentSearchResult } from "@/lib/collections/presenters/search";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
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
import { consumeSearchInputFocus } from "@/lib/search/pendingSearchFocus";
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
import type {
  SearchResultPage,
  SearchResultRowViewModel,
} from "@/lib/search/types";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_LIMIT = 20;

function queryKey(query: SearchQuery): string {
  return searchQueryToParams(query).toString();
}

function cloneRequestedKinds(
  kinds: ReadonlySet<SearchKind> | null,
): ReadonlySet<SearchKind> | null {
  return kinds === null ? null : new Set(kinds);
}

function toggleRequestedKind(
  requestedKinds: ReadonlySet<SearchKind> | null,
  kind: SearchKind,
): ReadonlySet<SearchKind> | null {
  const active =
    requestedKinds === null
      ? new Set<SearchKind>(SEARCH_KINDS)
      : new Set(requestedKinds);
  if (active.has(kind)) {
    active.delete(kind);
  } else {
    active.add(kind);
  }
  return active.size === SEARCH_KINDS.length ? null : active;
}

function hasExplicitEmptyKinds(query: SearchQuery): boolean {
  return query.requestedKinds !== null && query.requestedKinds.size === 0;
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
  const [mounted, setMounted] = useState(false);
  const [optimisticRequestedKinds, setOptimisticRequestedKinds] = useState<
    ReadonlySet<SearchKind> | null
  >(() => cloneRequestedKinds(query.requestedKinds));
  const pendingQueryRef = useRef(query);
  const expectedQueryStringRef = useRef<string | null>(queryString);
  const draftRef = useRef(query.text);
  const draftPinnedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Focus the box on the freshly-navigated-to blank landing. `mounted` flips the
  // input from its SSR-disabled state to enabled (the browser can only skip a
  // disabled autofocus, so autofocus is inert here); we focus it on that flip.
  // Gated on a Launcher-set request so ordinary arrivals — first-paint pane
  // restore, Back/Forward, a results URL — do not steal focus, and skipped when the
  // landing carries a query so a text navigation never yanks focus into the box.
  useEffect(() => {
    if (!mounted) return;
    if (!consumeSearchInputFocus()) return;
    if (!isBlankQuery(query)) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
    // Runs once when the input flips enabled; `query` is intentionally the landing
    // query captured at that flip, not a live dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: one-shot focus on the mount flip; re-running on query edits would refocus mid-typing.
  }, [mounted]);

  const replaceQuery = useCallback(
    (next: SearchQuery) => {
      const nextQueryString = queryKey(next);
      pendingQueryRef.current = next;
      expectedQueryStringRef.current = nextQueryString;
      setOptimisticRequestedKinds(cloneRequestedKinds(next.requestedKinds));
      paneRouter.replace(searchHref(next), {
        viewTransition: { kind: "collection-reflow" },
      });
    },
    [paneRouter],
  );

  const updateQuery = useCallback(
    (mutate: (current: SearchQuery) => SearchQuery) => {
      replaceQuery(mutate(pendingQueryRef.current));
    },
    [replaceQuery],
  );

  // Sync URL-backed state while preserving a locally edited draft until the URL
  // catches up to the draft's own replace. This prevents rapid chip updates from
  // replaying stale empty `q` values over text the user just typed.
  useEffect(() => {
    const expectedQueryString = expectedQueryStringRef.current;
    const isExpectedUrl =
      expectedQueryString !== null && queryString === expectedQueryString;
    const isSupersededUrl =
      expectedQueryString !== null && queryString !== expectedQueryString;
    if (isSupersededUrl) {
      return;
    }
    const preserveDraft = draftPinnedRef.current && !isExpectedUrl;
    if (preserveDraft) {
      pendingQueryRef.current = { ...query, text: draftRef.current };
    } else {
      pendingQueryRef.current = query;
      draftRef.current = query.text;
      setDraft(query.text);
      if (isExpectedUrl) {
        draftPinnedRef.current = false;
      }
    }
    setOptimisticRequestedKinds(cloneRequestedKinds(query.requestedKinds));
  }, [query, queryString]);

  // Debounced: parse the box, absorb completed operators into the query.
  useEffect(() => {
    const handle = setTimeout(() => {
      const parsed = parseSearchInput(draft);
      const merged = applyParsedInput(pendingQueryRef.current, parsed);
      if (queryKey(merged) !== expectedQueryStringRef.current) {
        replaceQuery(merged);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // query/queryString intentionally omitted: this effect reacts to box edits;
    // the equality guard prevents a replace loop when the URL already matches.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: URL query changes sync draft through the separate query.text effect; this debounce reacts only to box edits.
  }, [draft]);

  // First page: refetched (immediately, then aborted) whenever the effective
  // query changes; blank queries make no request. Pagination is appended below.
  const explicitEmptyKinds = hasExplicitEmptyKinds(query);
  const blank = isBlankQuery(query) || explicitEmptyKinds;
  const firstPage = useDebouncedFetch<SearchResultPage>(
    blank ? null : queryString,
    (signal) =>
      fetchSearchResultPage(query, { limit: PAGE_LIMIT, cursor: null, signal }),
    { debounceMs: 0 },
  );

  // "Load more" appends the next page(s); reset whenever the first page changes.
  const [more, setMore] = useState<{
    rows: SearchResultRowViewModel[];
    cursor: string | null;
  }>({ rows: [], cursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<FeedbackContent | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    moreAbortRef.current?.abort();
    setMore({ rows: [], cursor: null });
    setLoadingMore(false);
    setMoreError(null);
  }, [queryString]);

  const results = useMemo(
    () => (firstPage.data ? [...firstPage.data.rows, ...more.rows] : []),
    [firstPage.data, more.rows],
  );
  const nextCursor =
    more.rows.length > 0 ? more.cursor : (firstPage.data?.nextCursor ?? null);
  const searching = firstPage.loading || loadingMore;
  const hasSearched = explicitEmptyKinds || firstPage.data !== null;
  const error =
    firstPage.error !== null
      ? toFeedback(firstPage.error, { fallback: "Search failed" })
      : moreError;

  const loadMore = useCallback(
    async (cursor: string) => {
      moreAbortRef.current?.abort();
      const controller = new AbortController();
      moreAbortRef.current = controller;
      setLoadingMore(true);
      setMoreError(null);
      try {
        const page = await fetchSearchResultPage(query, {
          limit: PAGE_LIMIT,
          cursor,
          signal: controller.signal,
        });
        setMore((prev) => ({
          rows: [...prev.rows, ...page.rows],
          cursor: page.nextCursor,
        }));
      } catch (err) {
        if (isAbortError(err) || handleUnauthenticatedApiError(err)) return;
        setMoreError(toFeedback(err, { fallback: "Search failed" }));
      } finally {
        if (moreAbortRef.current === controller) setLoadingMore(false);
      }
    },
    [query],
  );

  const formatDisabled = hasFormatFilter(query);
  const creditDisabled = hasCreditFilter(query);
  const { kinds: disabledKindSet, reason: disabledReason } = disabledKinds({
    hasFormatFilter: formatDisabled,
    hasCreditFilter: creditDisabled,
  });

  const toggleKind = (kind: SearchKind) => {
    updateQuery((current) => {
      const requestedKinds = toggleRequestedKind(current.requestedKinds, kind);
      return { ...current, requestedKinds };
    });
  };

  const toggleFormat = (format: MediaFormat) => {
    updateQuery((current) => {
      const next = current.formats.includes(format)
        ? current.formats.filter((value) => value !== format)
        : [...current.formats, format];
      return { ...current, formats: next };
    });
  };

  const setAuthors = (authors: string[]) => {
    updateQuery((current) => ({ ...current, authors }));
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
      updateQuery((current) => ({
        ...current,
        formats: current.formats.filter((format) => format !== value),
      }));
    } else if (dim === "role") {
      updateQuery((current) => ({
        ...current,
        roles: current.roles.filter((role) => role !== value),
      }));
    } else if (dim === "scope") {
      updateQuery((current) => ({ ...current, scope: "all" }));
    }
  };

  const clearAllFilters = () => {
    updateQuery((current) => ({
      text: current.text,
      requestedKinds: null,
      formats: [],
      authors: [],
      roles: [],
      scope: "all",
    }));
  };

  const filtersActive = hasActiveFilters(query);

  const rows = useMemo(() => results.map(presentSearchResult), [results]);

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio:
        rows.length > 0
          ? { kind: "count", value: rows.length, unit: "result" }
          : { kind: "none" },
      pending: searching,
    },
  });

  const notice =
    error || searching ? (
      <>
        {error ? <FeedbackNotice feedback={error} /> : null}
        {searching ? <FeedbackNotice severity="info">Searching…</FeedbackNotice> : null}
      </>
    ) : undefined;

  // CollectionView shows `empty` whenever there are no rows: the initial prompt
  // before any search, then "no results" once a search has returned nothing.
  const empty = hasSearched ? (
    <div className={styles.emptyResults}>
      <FeedbackNotice severity="neutral">No results found.</FeedbackNotice>
      {filtersActive ? (
        <Button variant="secondary" size="md" onClick={clearAllFilters}>
          Clear filters
        </Button>
      ) : null}
    </div>
  ) : (
    <FeedbackNotice severity="info">
      Search everything in your Nexus. Narrow with the kind chips or filters.
    </FeedbackNotice>
  );

  return (
    <CollectionView
      rows={rows}
      status="ready"
      ariaLabel="Search results"
      opener={<SectionOpener heading="Search" />}
      toolbar={
        <div className={styles.searchForm}>
          <Input
            ref={searchInputRef}
            aria-label="Search content"
            className={styles.searchInputField}
            size="lg"
            value={draft}
            onChange={(event) => {
              const nextDraft = event.target.value;
              draftRef.current = nextDraft;
              draftPinnedRef.current = true;
              expectedQueryStringRef.current = null;
              pendingQueryRef.current = {
                ...pendingQueryRef.current,
                text: nextDraft,
              };
              setDraft(nextDraft);
            }}
            placeholder="Search your Nexus… (try format:pdf or author:le-guin)"
            disabled={!mounted}
          />

          <KindChips
            selected={optimisticRequestedKinds}
            disabled={disabledKindSet}
            disabledReason={disabledReason}
            onToggle={toggleKind}
          />

          <div className={styles.refineRow}>
            <ActionMenu
              label="+ Format"
              options={MEDIA_FORMATS.map((format) => ({
                kind: "command" as const,
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
      }
      notice={notice}
      empty={empty}
      footer={
        <LoadMoreFooter
          hasMore={nextCursor !== null}
          loading={searching}
          onLoadMore={() => {
            if (nextCursor) void loadMore(nextCursor);
          }}
          label="Load more"
        />
      }
    />
  );
}
