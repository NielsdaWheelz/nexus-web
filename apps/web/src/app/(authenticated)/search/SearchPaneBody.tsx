/**
 * Search page — one box, six kind chips, operator-backed filter chips.
 *
 * Searches all kinds by default; refine after via the kind row, the "+ Format"
 * menu, the author picker, or typed operators (format:/author:/role:/in:). All
 * refinements render as removable chips. Hybrid retrieval is invisible.
 */

"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import ActionMenu from "@/components/ui/ActionMenu";
import CollectionView from "@/components/collections/CollectionView";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import ContributorFilter from "@/components/contributors/ContributorFilter";
import KindChips from "@/components/search/KindChips";
import AppliedFilters, {
  type AppliedFilterChip,
} from "@/components/ui/AppliedFilters";
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
import {
  applyParsedInput,
  hasActiveFilters,
  hasCreditFilter,
  emptySearchQuery,
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
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneRouter,
  usePaneSearchParams,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_LIMIT = 20;

interface SearchSnapshot {
  readonly queryKey: string;
  readonly rows: readonly SearchResultRowViewModel[];
  readonly nextCursor: string | null;
  readonly hasSearched: boolean;
}

const SEARCH_VISIT_DATA =
  definePaneVisitDataKey<SearchSnapshot>("Search.Results");
const EMPTY_SEARCH_ROWS: readonly SearchResultRowViewModel[] = [];

function searchErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "Search couldn’t be completed",
        message: "Check your connection and retry.",
        requestId: error.requestId,
      };
    case "E_INVALID_CURSOR":
      return {
        tone: "Danger",
        title: "More results couldn’t be loaded",
        message: "Retry from the current results.",
        requestId: error.requestId,
      };
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title: "This search isn’t valid",
        message: "Adjust the query or filters and retry.",
        requestId: error.requestId,
      };
    case "E_NOT_FOUND":
    case "E_CONVERSATION_NOT_FOUND":
      return {
        tone: "Danger",
        title: "The search scope is no longer available",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

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
  const explicitEmptyKinds = hasExplicitEmptyKinds(query);
  const blank = isBlankQuery(query) || explicitEmptyKinds;

  const committedSnapshotRef = useRef<SearchSnapshot | null>(null);
  const captureCommitted = useCallback(
    () => committedSnapshotRef.current,
    [],
  );
  const restored = usePaneVisitData(SEARCH_VISIT_DATA, captureCommitted);
  const restoredForQuery = restored?.queryKey === queryString ? restored : null;
  const [controller, setController] = useState<SearchSnapshot | null>(() =>
    restoredForQuery ??
    (blank
      ? { queryKey: queryString, rows: [], nextCursor: null, hasSearched: explicitEmptyKinds }
      : null),
  );
  const allowFirstPageAdoptionRef = useRef(restoredForQuery === null && !blank);
  const controllerQueryKeyRef = useRef(queryString);
  const activeQueryKeyRef = useRef(queryString);
  activeQueryKeyRef.current = queryString;
  const firstPageLoadingQueryRef = useRef<string | null>(
    blank || restoredForQuery !== null ? null : queryString,
  );

  const [draft, setDraft] = useState(query.text);
  const [mounted, setMounted] = useState(false);
  const [optimisticRequestedKinds, setOptimisticRequestedKinds] = useState<
    ReadonlySet<SearchKind> | null
  >(() => cloneRequestedKinds(query.requestedKinds));
  const pendingQueryRef = useRef(query);
  const expectedQueryStringRef = useRef<string | null>(queryString);
  const draftRef = useRef(query.text);
  const draftPinnedRef = useRef(false);
  const escapeClearedDraftRef = useRef(false);
  const { inputRef: searchInputRef, focusInput } = usePaneCollectionInput();

  useEffect(() => {
    setMounted(true);
  }, []);

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
    const escapeClearedDraft = escapeClearedDraftRef.current;
    escapeClearedDraftRef.current = false;
    if (escapeClearedDraft && draft === "") {
      return;
    }
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
  const firstPage = useDebouncedFetch<SearchResultPage>(
    blank || restoredForQuery !== null ? null : queryString,
    (signal) =>
      fetchSearchResultPage(query, { limit: PAGE_LIMIT, cursor: null, signal }),
    { debounceMs: 0 },
  );

  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (controllerQueryKeyRef.current === queryString) return;
    controllerQueryKeyRef.current = queryString;
    moreAbortRef.current?.abort();
    setLoadingMore(false);
    setMoreError(null);
    allowFirstPageAdoptionRef.current = restoredForQuery === null && !blank;
    setController((current) =>
      restoredForQuery ??
      (blank
        ? { queryKey: queryString, rows: [], nextCursor: null, hasSearched: explicitEmptyKinds }
        : current),
    );
  }, [blank, explicitEmptyKinds, queryString, restoredForQuery]);

  useEffect(() => {
    if (firstPage.loading) {
      firstPageLoadingQueryRef.current = queryString;
      return;
    }
    if (
      firstPageLoadingQueryRef.current !== queryString ||
      !allowFirstPageAdoptionRef.current ||
      firstPage.data === null ||
      firstPage.dataIdentity !== queryString
    ) {
      return;
    }
    allowFirstPageAdoptionRef.current = false;
    setController({
      queryKey: queryString,
      rows: firstPage.data.rows,
      nextCursor: firstPage.data.nextCursor,
      hasSearched: true,
    });
  }, [firstPage.data, firstPage.dataIdentity, firstPage.loading, queryString]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = controller;
  }, [controller]);

  const results = blank && controller?.queryKey !== queryString
    ? EMPTY_SEARCH_ROWS
    : controller?.rows ?? EMPTY_SEARCH_ROWS;
  const currentController = controller?.queryKey === queryString ? controller : null;
  const retained = controller !== null && currentController === null && !blank;
  const nextCursor = currentController?.nextCursor ?? null;
  const firstPageError =
    firstPage.errorIdentity === queryString ? firstPage.error : null;
  const searching =
    (!blank && currentController === null && firstPageError === null) || loadingMore;
  const hasSearched = currentController?.hasSearched ?? false;
  const error =
    currentController === null && firstPageError !== null
      ? searchErrorMessage(firstPageError)
      : currentController !== null ? moreError : null;
  usePaneReturnReady(currentController !== null || firstPageError !== null);

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
        if (activeQueryKeyRef.current !== queryString) return;
        setController((current) =>
          current === null || current.queryKey !== queryString
            ? current
            : {
                ...current,
                rows: [...current.rows, ...page.rows],
                nextCursor: page.nextCursor,
              },
        );
      } catch (err) {
        if (isAbortError(err) || handleUnauthenticatedApiError(err)) return;
        if (activeQueryKeyRef.current !== queryString) return;
        try {
          setMoreError(searchErrorMessage(err));
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
      } finally {
        if (moreAbortRef.current === controller) setLoadingMore(false);
      }
    },
    [query, queryString],
  );

  const formatDisabled = hasFormatFilter(query);
  const creditDisabled = hasCreditFilter(query);
  const { kinds: disabledKindSet, reason: disabledReason } = useMemo(
    () => disabledKinds({
      hasFormatFilter: formatDisabled,
      hasCreditFilter: creditDisabled,
    }),
    [creditDisabled, formatDisabled],
  );

  const toggleKind = useCallback((kind: SearchKind) => {
    updateQuery((current) => {
      const requestedKinds = toggleRequestedKind(current.requestedKinds, kind);
      return { ...current, requestedKinds };
    });
  }, [updateQuery]);

  const toggleFormat = useCallback((format: MediaFormat) => {
    updateQuery((current) => {
      const next = current.formats.includes(format)
        ? current.formats.filter((value) => value !== format)
        : [...current.formats, format];
      return { ...current, formats: next };
    });
  }, [updateQuery]);

  const setAuthors = useCallback((authors: string[]) => {
    updateQuery((current) => ({ ...current, authors }));
  }, [updateQuery]);

  // Authors are owned by ContributorFilter (which resolves handles to display names);
  // the applied-filter bar carries the operator chips it doesn't own.
  const appliedChips: AppliedFilterChip[] = useMemo(() => [
    ...query.formats.map((format) => ({
      id: `format:${format}`,
      label: MEDIA_FORMAT_LABELS[format],
    })),
    ...query.roles.map((role) => ({ id: `role:${role}`, label: `Role: ${role}` })),
    ...(query.scope !== "all"
      ? [{ id: `scope:${query.scope}`, label: `In: ${query.scope}` }]
      : []),
  ], [query.formats, query.roles, query.scope]);

  const removeFilter = useCallback((id: string) => {
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
  }, [updateQuery]);

  const clearAllFilters = useCallback(() => {
    updateQuery((current) => ({
      text: current.text,
      requestedKinds: null,
      formats: [],
      authors: [],
      roles: [],
      scope: "all",
    }));
  }, [updateQuery]);

  const updateDraft = useCallback((nextDraft: string) => {
    escapeClearedDraftRef.current = false;
    draftRef.current = nextDraft;
    draftPinnedRef.current = true;
    expectedQueryStringRef.current = null;
    pendingQueryRef.current = {
      ...pendingQueryRef.current,
      text: nextDraft,
    };
    setDraft(nextDraft);
  }, []);
  const resetView = useCallback(() => {
    updateDraft("");
    replaceQuery(emptySearchQuery());
  }, [replaceQuery, updateDraft]);

  const filtersActive = hasActiveFilters(query);

  const rows = useMemo(() => results.map(presentSearchResult), [results]);
  const resultStatus = retained
    ? `${results.length} results retained from the previous search; ${firstPageError === null ? "updating" : "update failed"}.`
    : error
      ? currentController === null
        ? "Results unavailable."
        : `${results.length} loaded results; loading more failed.`
      : searching
        ? "Searching…"
        : hasSearched
          ? `${results.length} loaded results${nextCursor === null ? "." : "; more available."}`
          : "Ready to search.";

  const toolbar = useMemo(() => (
    <PaneToolbar
      variant="Refinement"
      search={
        <div className={styles.searchInputRow}>
          <Input
            ref={searchInputRef}
            aria-label="Search content"
            className={styles.searchInputField}
            size="lg"
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              updateDraft("");
              escapeClearedDraftRef.current = true;
            }}
            placeholder="Search your Nexus… (try format:pdf or author:le-guin)"
            disabled={!mounted}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!draft}
            onClick={() => updateDraft("")}
          >
            Clear text
          </Button>
        </div>
      }
      filters={
        <>
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
          <span>Sort by: relevance</span>
        </>
      }
      controls={
        <>
          <span role="status" aria-live="polite">{resultStatus}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!draft && !query.text && !filtersActive}
            onClick={resetView}
          >
            Reset view
          </Button>
        </>
      }
    />
  ), [
    appliedChips,
    clearAllFilters,
    disabledKindSet,
    disabledReason,
    draft,
    filtersActive,
    mounted,
    optimisticRequestedKinds,
    query.authors,
    query.text,
    removeFilter,
    resetView,
    resultStatus,
    searchInputRef,
    setAuthors,
    toggleFormat,
    toggleKind,
    updateDraft,
  ]);
  const collection = useMemo(
    () => ({ label: "Search controls", content: toolbar, focusInput }),
    [focusInput, toolbar],
  );
  usePanePrimaryChrome({
    collection,
    header: {
      kind: "Section",
      meta: searching
        ? { kind: "Pending" }
        : rows.length > 0
          ? { kind: "Count", value: rows.length, unit: "result" }
          : { kind: "None" },
    },
  });

  const notice =
    error || searching ? (
      <>
        {error ? (
          <FeedbackNotice content={error} announcement="Assertive" />
        ) : null}
        {searching ? (
          <FeedbackNotice
            content={{ tone: "Info", title: "Searching…" }}
            announcement="None"
          />
        ) : null}
      </>
    ) : undefined;

  // CollectionView shows `empty` whenever there are no rows: the initial prompt
  // before any search, then "no results" once a search has returned nothing.
  const empty = retained || (error && currentController === null) ? null : hasSearched ? (
    <div className={styles.emptyResults}>
      <FeedbackNotice
        content={{ tone: "Neutral", title: "No results found." }}
        announcement="None"
      />
      {filtersActive ? (
        <Button variant="secondary" size="md" onClick={clearAllFilters}>
          Clear filters
        </Button>
      ) : null}
    </div>
  ) : (
    <FeedbackNotice
      content={{
        tone: "Info",
        title: "Search everything in your Nexus",
        message: "Narrow with the kind chips or filters.",
      }}
      announcement="None"
    />
  );

  if (defect) throw defect.error;

  return (
    <CollectionView
      returnScope="Search.Results"
      rows={rows}
      status="ready"
      ariaLabel="Search results"
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
