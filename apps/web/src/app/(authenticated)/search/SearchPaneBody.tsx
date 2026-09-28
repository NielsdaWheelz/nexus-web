/**
 * Search page: one input, disclosed kinds/formats/authors, and applied chips.
 * The URL owns submitted filters; the draft can temporarily differ.
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
import { X } from "lucide-react";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import CollectionView from "@/components/collections/CollectionView";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import ContributorFilter, { useContributorFilterLabels } from "@/components/contributors/ContributorFilter";
import type { ContributorSearchItem } from "@/lib/contributors/types";
import KindChips from "@/components/search/KindChips";
import CollectionFilterEditor from "@/components/workspace/CollectionFilterEditor";
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
  SEARCH_KIND_LABELS,
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
  const [forcedClear, setForcedClear] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [optimisticRequestedKinds, setOptimisticRequestedKinds] = useState<
    ReadonlySet<SearchKind> | null
  >(() => cloneRequestedKinds(query.requestedKinds));
  const pendingQueryRef = useRef(query);
  const expectedQueryStringRef = useRef<string | null>(queryString);
  const draftRef = useRef(query.text);
  const draftPinnedRef = useRef(false);
  const escapeClearedDraftRef = useRef(false);
  const preserveCommittedTextRef = useRef(false);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const { inputRef: searchInputRef, focusInput } = usePaneCollectionInput();
  const { labels: authorLabels, remember: rememberAuthor } = useContributorFilterLabels(query.authors);

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
      const pending = pendingQueryRef.current;
      replaceQuery(mutate(preserveCommittedTextRef.current
        ? { ...pending, text: query.text }
        : pending));
    },
    [query.text, replaceQuery],
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
    const preserveDraft = draftPinnedRef.current && (!isExpectedUrl || preserveCommittedTextRef.current);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: URL query changes sync draft through the separate query.text effect; this debounce reacts only to box edits and explicit text clear.
  }, [draft, forcedClear]);

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

  const addAuthor = useCallback((item: ContributorSearchItem) => {
    rememberAuthor(item);
    updateQuery((current) => ({
      ...current,
      authors: current.authors.includes(item.handle)
        ? current.authors
        : [...current.authors, item.handle],
    }));
  }, [rememberAuthor, updateQuery]);

  const appliedChips: AppliedFilterChip[] = useMemo(() => [
    ...(query.requestedKinds === null ? [] : [{
      id: "kinds",
      label: query.requestedKinds.size === 0
        ? "No content types"
        : `Content types: ${SEARCH_KINDS.filter((kind) => query.requestedKinds?.has(kind))
            .map((kind) => SEARCH_KIND_LABELS[kind]).join(", ")}`,
    }]),
    ...[...new Set(query.formats)].map((format) => ({
      id: `format:${format}`,
      label: `Format: ${MEDIA_FORMAT_LABELS[format]}`,
    })),
    ...[...new Set(query.authors)].map((handle) => ({
      id: `author:${handle}`,
      label: `Author: ${authorLabels[handle] ?? handle}`,
    })),
    ...[...new Set(query.roles)].map((role) => ({ id: `role:${role}`, label: `Role: ${role}` })),
    ...(query.scope !== "all"
      ? [{ id: `scope:${query.scope}`, label: `In: ${query.scope}` }]
      : []),
  ], [authorLabels, query.authors, query.formats, query.requestedKinds, query.roles, query.scope]);

  const removeFilter = useCallback((id: string) => {
    const separator = id.indexOf(":");
    const dim = id.slice(0, separator);
    const value = id.slice(separator + 1);
    if (id === "kinds") {
      updateQuery((current) => ({ ...current, requestedKinds: null }));
    } else if (dim === "author") {
      updateQuery((current) => ({
        ...current,
        authors: current.authors.filter((handle) => handle !== value),
      }));
    } else if (dim === "format") {
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
    preserveCommittedTextRef.current = false;
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

  const announceResultStatus = error === null;
  const toolbar = useMemo(() => (
    <PaneToolbar
      variant="Collection"
      search={
        <div className={styles.searchInputRow}>
          <Input
            ref={searchInputRef}
            aria-label="Search content"
            className={styles.searchInputField}
            size="md"
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              updateDraft("");
              preserveCommittedTextRef.current = true;
              escapeClearedDraftRef.current = true;
            }}
            placeholder="Search your Nexus"
            disabled={!mounted}
          />
          {draft || query.text ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Clear text filter"
              title="Clear text filter"
              onClick={() => {
                updateDraft("");
                if (!draft && query.text) setForcedClear((value) => value + 1);
                searchInputRef.current?.focus({ preventScroll: true });
              }}
            >
              <X size={15} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      }
      filters={
        <>
          <span className={styles.sortLabel}>Order: relevance</span>
          <CollectionFilterEditor
            activeCount={appliedChips.length}
            triggerRef={filterTriggerRef}
            onClearFilters={clearAllFilters}
            onResetView={draft || query.text || filtersActive ? resetView : undefined}
          >
            <KindChips
              selected={optimisticRequestedKinds}
              disabled={disabledKindSet}
              disabledReason={disabledReason}
              onToggle={toggleKind}
            />
            <div className={styles.formatGroup} role="group" aria-label="Formats">
              <span>Formats</span>
              <div className={styles.formatOptions}>
                {MEDIA_FORMATS.map((format) => (
                  <Button
                    key={format}
                    size="sm"
                    variant="pill"
                    aria-pressed={query.formats.includes(format)}
                    onClick={() => toggleFormat(format)}
                  >
                    {MEDIA_FORMAT_LABELS[format]}
                  </Button>
                ))}
              </div>
            </div>
            <ContributorFilter selectedHandles={query.authors} onAdd={addAuthor} />
            <p className={styles.operatorHint}>
              You can also type format:pdf or author:le-guin in search.
            </p>
          </CollectionFilterEditor>
        </>
      }
      summary={
        <div className={styles.summary}>
          {query.text && query.text !== draft ? (
            <span className={styles.committedQuery}>Search: {query.text}</span>
          ) : null}
          <AppliedFilters
            chips={appliedChips}
            onRemove={removeFilter}
            returnFocusTo={filterTriggerRef}
          />
          <span
            role={announceResultStatus ? "status" : undefined}
            aria-live={announceResultStatus ? "polite" : undefined}
          >
            {resultStatus}
          </span>
        </div>
      }
    />
  ), [
    addAuthor,
    appliedChips,
    announceResultStatus,
    clearAllFilters,
    disabledKindSet,
    disabledReason,
    draft,
    filtersActive,
    mounted,
    optimisticRequestedKinds,
    query.authors,
    query.formats,
    query.text,
    removeFilter,
    resetView,
    resultStatus,
    searchInputRef,
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
        : retained
          ? { kind: "None" }
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
