/**
 * Search page: one input, disclosed kinds/formats/authors, and applied chips.
 * The URL owns submitted filters; the draft can temporarily differ.
 */

"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import Button from "@/components/ui/Button";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import ChoiceField from "@/components/ui/ChoiceField";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import CollectionView from "@/components/collections/CollectionView";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import ContributorFilter, { useContributorFilterLabels } from "@/components/contributors/ContributorFilter";
import type { ContributorSearchItem } from "@/lib/contributors/api";
import type { AppliedFilterChip } from "@/components/ui/AppliedFilters";
import { presentSearchResult } from "@/lib/collections/presenters/search";
import { useMediaQueryRevision, useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useResource } from "@/lib/api/useResource";
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
  usePaneIsVisible,
  usePaneRouter,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneVisitData,
} from "@/lib/workspace/paneReturnMemento";
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
  const isPaneVisible = usePaneIsVisible();
  const paneSearchParams = usePaneSearchParams();
  const query = useMemo(
    () => searchQueryFromParams(paneSearchParams),
    [paneSearchParams],
  );
  const queryString = queryKey(query);
  const explicitEmptyKinds = hasExplicitEmptyKinds(query);
  const blank = isBlankQuery(query) || explicitEmptyKinds;
  const queryRevision = useMediaQueryRevision();
  const firstPageTransportKey = `${queryString}:facts:${queryRevision}`;
  const currentQueryRevisionRef = useRef(queryRevision);
  currentQueryRevisionRef.current = queryRevision;
  const adoptedQueryRevisionRef = useRef(queryRevision);

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
    blank || restoredForQuery !== null || controller?.queryKey === queryString || !isPaneVisible ? null : firstPageTransportKey,
  );

  const [draft, setDraft] = useState(query.text);
  const draftCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusId = useId();
  const [mounted, setMounted] = useState(false);
  const [optimisticRequestedKinds, setOptimisticRequestedKinds] = useState<
    ReadonlySet<SearchKind> | null
  >(() => cloneRequestedKinds(query.requestedKinds));
  const pendingQueryRef = useRef(query);
  const expectedQueryStringRef = useRef<string | null>(queryString);
  const draftRef = useRef(query.text);
  const draftPinnedRef = useRef(false);
  const { inputRef: searchInputRef, focusInput } = usePaneQueryInput();
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
      draftCommitRef.current = null;
      const parsed = parseSearchInput(draft);
      const merged = applyParsedInput(pendingQueryRef.current, parsed);
      if (queryKey(merged) !== expectedQueryStringRef.current) {
        replaceQuery(merged);
      }
    }, SEARCH_DEBOUNCE_MS);
    draftCommitRef.current = handle;
    return () => {
      clearTimeout(handle);
      if (draftCommitRef.current === handle) draftCommitRef.current = null;
    };
    // query/queryString intentionally omitted: this effect reacts to box edits;
    // the equality guard prevents a replace loop when the URL already matches.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: URL query changes sync draft through the separate query.text effect; this debounce reacts only to box edits; clear commits synchronously.
  }, [draft]);

  // First page: refetched (immediately, then aborted) whenever the effective
  // query changes; blank queries make no request. Pagination is appended below.
  const firstPage = useDebouncedFetch<SearchResultPage>(
    blank || restoredForQuery !== null || controller?.queryKey === queryString || !isPaneVisible ? null : firstPageTransportKey,
    (signal) =>
      fetchSearchResultPage(query, { limit: PAGE_LIMIT, cursor: null, signal }),
    { debounceMs: 0 },
  );

  const [loadingMore, setLoadingMore] = useState(false);
  const [prefixRequest, setPrefixRequest] = useState<{
    key: string; revision: number; count: number;
  } | null>(null);
  const restoreNeedsRefreshRef = useRef(restoredForQuery !== null);
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => moreAbortRef.current?.abort(), []);
  useLayoutEffect(() => {
    moreAbortRef.current?.abort();
    setLoadingMore(false);
  }, [queryRevision]);

  useEffect(() => {
    if (controllerQueryKeyRef.current === queryString) return;
    controllerQueryKeyRef.current = queryString;
    moreAbortRef.current?.abort();
    setPrefixRequest(null);
    restoreNeedsRefreshRef.current = restoredForQuery !== null;
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
      firstPageLoadingQueryRef.current = firstPageTransportKey;
      return;
    }
    if (
      firstPageLoadingQueryRef.current !== firstPageTransportKey ||
      !allowFirstPageAdoptionRef.current ||
      firstPage.data === null ||
      firstPage.dataIdentity !== firstPageTransportKey
    ) {
      return;
    }
    allowFirstPageAdoptionRef.current = false;
    adoptedQueryRevisionRef.current = queryRevision;
    setController({
      queryKey: queryString,
      rows: firstPage.data.rows,
      nextCursor: firstPage.data.nextCursor,
      hasSearched: true,
    });
  }, [firstPage.data, firstPage.dataIdentity, firstPage.loading, queryString, firstPageTransportKey, queryRevision]);

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
    firstPage.errorIdentity === firstPageTransportKey ? firstPage.error : null;
  const searching =
    (!blank && currentController === null && firstPageError === null) || loadingMore;
  const hasSearched = currentController?.hasSearched ?? false;
  const error =
    currentController === null && firstPageError !== null
      ? searchErrorMessage(firstPageError)
      : null;
  usePaneReturnReady(currentController !== null || firstPageError !== null);

  useEffect(() => {
    if (blank || currentController === null ||
      (adoptedQueryRevisionRef.current === queryRevision && !restoreNeedsRefreshRef.current) ||
      (prefixRequest?.key === queryString && prefixRequest.revision === queryRevision)) return;
    setPrefixRequest({ key: queryString, revision: queryRevision, count: currentController.rows.length });
  }, [blank, currentController, prefixRequest, queryRevision, queryString]);
  const prefix = useResource<{ request: NonNullable<typeof prefixRequest>; page: SearchResultPage }>({
    cacheKey: prefixRequest !== null && prefixRequest.key === queryString &&
      prefixRequest.revision === queryRevision
      ? `${prefixRequest.key}:facts:${prefixRequest.revision}` : null,
    load: async (signal) => {
      const request = prefixRequest;
      if (request === null) {
        // justify-defect: the prefix query is enabled only for its request.
        throw new Error("Search prefix lost its request");
      }
      let page = await fetchSearchResultPage(query, {
        limit: request.count === 0 ? PAGE_LIMIT : Math.min(PAGE_LIMIT, request.count), signal,
      });
      const rows = [...page.rows];
      while (rows.length < request.count && page.nextCursor !== null) {
        page = await fetchSearchResultPage(query, { cursor: page.nextCursor,
          limit: Math.min(PAGE_LIMIT, request.count - rows.length), signal,
        });
        rows.push(...page.rows);
      }
      return { request, page: { ...page, rows } };
    },
  });
  useEffect(() => {
    if (prefix.status !== "ready" || prefix.data.request !== prefixRequest ||
      prefixRequest?.key !== queryString || prefixRequest.revision !== queryRevision) return;
    const page = prefix.data.page;
    adoptedQueryRevisionRef.current = prefix.data.request.revision;
    restoreNeedsRefreshRef.current = false;
    setController((current) => current === null || current.queryKey !== queryString ? current : {
      ...current, rows: page.rows, nextCursor: page.nextCursor,
    });
    setMoreError(null);
    setPrefixRequest(null);
  }, [prefix, prefixRequest, queryString, queryRevision]);

  const loadMore = useCallback(
    async (cursor: string) => {
      if (prefixRequest !== null || adoptedQueryRevisionRef.current !== queryRevision) return;
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
        if (controller.signal.aborted || moreAbortRef.current !== controller ||
          activeQueryKeyRef.current !== queryString || currentQueryRevisionRef.current !== queryRevision) return;
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
        if (controller.signal.aborted || moreAbortRef.current !== controller ||
          activeQueryKeyRef.current !== queryString || currentQueryRevisionRef.current !== queryRevision) return;
        if (isAbortError(err) || handleUnauthenticatedApiError(err)) return;
        try {
          searchErrorMessage(err);
          if (!isApiError(err)) throw err;
          setMoreError(err);
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
      } finally {
        if (moreAbortRef.current === controller) setLoadingMore(false);
      }
    },
    [query, queryString, queryRevision, prefixRequest],
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
    draftRef.current = nextDraft;
    draftPinnedRef.current = true;
    expectedQueryStringRef.current = null;
    pendingQueryRef.current = {
      ...pendingQueryRef.current,
      text: nextDraft,
    };
    setDraft(nextDraft);
  }, []);
  const clearText = useCallback(() => {
    if (draftCommitRef.current !== null) clearTimeout(draftCommitRef.current);
    draftCommitRef.current = null;
    updateDraft("");
    draftPinnedRef.current = false;
    replaceQuery({ ...pendingQueryRef.current, text: "" });
  }, [replaceQuery, updateDraft]);
  const resetView = useCallback(() => {
    if (draftCommitRef.current !== null) clearTimeout(draftCommitRef.current);
    draftCommitRef.current = null;
    updateDraft("");
    draftPinnedRef.current = false;
    replaceQuery(emptySearchQuery());
  }, [replaceQuery, updateDraft]);

  const filtersActive = hasActiveFilters(query);

  const summaries = useMediaSummaries(results.flatMap((result) =>
    "mediaSummary" in result ? [result.mediaSummary] : []));
  const rows = results.flatMap((result) => {
    if (!("mediaSummary" in result)) return [presentSearchResult(result)];
    const mediaSummary = summaries.resolve(result.mediaSummary);
    return mediaSummary === null ? [] : [presentSearchResult({ ...result, mediaSummary: mediaSummary })];
  });
  const resultStatus = retained
    ? `${rows.length} results retained from the previous search; ${firstPageError === null ? "updating" : "update failed"}.`
    : error
      ? currentController === null
        ? "Results unavailable."
        : `${rows.length} loaded results; loading more failed.`
      : searching
        ? "Searching…"
        : hasSearched
          ? `${rows.length} loaded results${nextCursor === null ? "." : "; more available."}`
          : "Ready to search.";

  const announceResultStatus = error === null;
  const queryControls = {
    kind: "Controls" as const,
    label: "Search content",
    focusInput,
    content: <PaneQueryToolbar
      inputRef={searchInputRef}
      input={{ label: "Search content", placeholder: "Search your Nexus", value: draft, appliedValue: query.text, onChange: updateDraft, onClear: clearText, disabled: !mounted }}
      options={{
        label: "Filters",
        activeCount: appliedChips.length,
        onClear: clearAllFilters,
        content: <>
          <fieldset className={styles.optionGroup}>
            <legend>Content types</legend>
            <div className={styles.choices}>
              {SEARCH_KINDS.map((kind) => <ChoiceField
                key={kind}
                label={SEARCH_KIND_LABELS[kind]}
                checked={(optimisticRequestedKinds === null || optimisticRequestedKinds.has(kind)) && !disabledKindSet.has(kind)}
                disabled={disabledKindSet.has(kind)}
                description={disabledKindSet.has(kind) ? disabledReason ?? undefined : undefined}
                onChange={() => toggleKind(kind)}
              />)}
            </div>
          </fieldset>
          <fieldset className={styles.optionGroup}>
            <legend>Formats</legend>
            <div className={styles.choices}>
              {MEDIA_FORMATS.map((format) => <ChoiceField key={format} label={MEDIA_FORMAT_LABELS[format]} checked={query.formats.includes(format)} onChange={() => toggleFormat(format)} />)}
            </div>
          </fieldset>
          <ContributorFilter selectedHandles={query.authors} onAdd={addAuthor} />
          <p className={styles.operatorHint}>You can also type format:pdf or author:le-guin in search.</p>
        </>,
      }}
      chips={{ items: appliedChips, onRemove: removeFilter }}
      status={{ id: statusId, content: <>
        <span>Order: relevance</span>
        <span id={statusId} role={announceResultStatus ? "status" : undefined} aria-live={announceResultStatus ? "polite" : undefined} aria-atomic={announceResultStatus ? true : undefined}>{resultStatus}</span>
      </> }}
      onReset={draft || query.text || filtersActive ? resetView : undefined}
    />,
  };
  usePaneChrome({
    query: queryControls,
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
        message: "Open filters to narrow by content type, format or author.",
      }}
      announcement="None"
    />
  );

  if (defect) throw defect.error;
  const refreshError = summaries.error ?? (prefix.status === "error" ? prefix.error : null) ?? moreError;

  return (
    <CollectionView
      returnScope="Search.Results"
      rows={rows}
      status="ready"
      ariaLabel="Search results"
      notice={notice || refreshError ? <>{notice}<MediaSummaryNotice
        error={refreshError}
        retry={() => {
          if (summaries.error !== null) summaries.retry();
          if (prefix.status === "error") prefix.retry();
          if (moreError !== null && nextCursor !== null) void loadMore(nextCursor);
        }}
      /></> : undefined}
      empty={empty}
      footer={
        <LoadMoreFooter
          hasMore={nextCursor !== null}
          loading={searching || prefix.status === "loading"}
          disabled={prefixRequest !== null || adoptedQueryRevisionRef.current !== queryRevision}
          onLoadMore={() => {
            if (nextCursor) void loadMore(nextCursor);
          }}
          label="Load more"
        />
      }
    />
  );
}
