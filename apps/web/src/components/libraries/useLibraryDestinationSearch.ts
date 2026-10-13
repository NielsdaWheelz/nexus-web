import { useLayoutEffect, useRef, useState } from "react";
import type {
  LibraryDestination,
  LibraryDestinationPage,
} from "@/lib/libraries/destinationContract";

const QUERY_DELAY_MS = 180;

/** One page of writable destinations, the transport's own failure, or a
    failure the transport dealt with itself (an auth redirect): the search then
    keeps what it has and shows nothing. The search never rejects: a rejection
    is a defect of the caller's transport. */
export type LibraryDestinationSearchResult<Failure> =
  | { kind: "page"; page: LibraryDestinationPage }
  | { kind: "failure"; failure: Failure }
  | { kind: "handled" };

export interface LibraryDestinationSearch<Failure> {
  query: string;
  setQuery: (query: string) => void;
  /** trimmed and lowercased: what the transport is asked for */
  normalizedQuery: string;
  results: readonly LibraryDestination[];
  /** the normalized query `results` answer */
  resultsQuery: string;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  failure: Failure | null;
  /** re-issues whichever request failed: the search, or the Load More */
  retry: () => void;
  loadMore: () => void;
}

/**
 * The writable-destination search state over any transport: one request
 * generation over open, typing, retry and Load More, so only the latest
 * request commits. Opening, a retry and an empty query search at once; a typed
 * query waits for a pause. Deactivating aborts the read but keeps the query
 * and the last good results, so reactivating re-issues the preserved query.
 */
export function useLibraryDestinationSearch<Failure>({
  active,
  search,
}: {
  active: boolean;
  search: (request: {
    q: string;
    cursor: string | null;
    signal: AbortSignal;
  }) => Promise<LibraryDestinationSearchResult<Failure>>;
}): LibraryDestinationSearch<Failure> {
  const [query, setQueryText] = useState("");
  const [request, setRequest] = useState({ query: "", immediate: true });
  const [results, setResults] = useState<readonly LibraryDestination[]>([]);
  const [resultsQuery, setResultsQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<{
    failure: Failure;
    during: "search" | "more";
  } | null>(null);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const requestedQuery = useRef("");
  const installed = useRef<{
    generation: number;
    query: string;
    cursor: string | null;
  } | null>(null);
  const wasActive = useRef(false);
  const normalizedQuery = request.query;

  function retire() {
    ++generation.current;
    abort.current?.abort();
    abort.current = null;
    installed.current = null;
  }

  function requestSearch(next: { query: string; immediate: boolean }) {
    // The event retires continuation authority before React commits or the
    // replacement search debounces. Cancellation alone cannot fence extension replies.
    requestedQuery.current = next.query;
    retire();
    setNextCursor(null);
    setLoading(active);
    setLoadingMore(false);
    setFailure(null);
    setRequest(next);
  }

  function setQuery(nextQuery: string) {
    setQueryText(nextQuery);
    const normalized = nextQuery.trim().toLowerCase();
    if (normalized !== requestedQuery.current) {
      requestSearch({ query: normalized, immediate: false });
    }
  }

  useLayoutEffect(() => {
    const immediate =
      (active && !wasActive.current) || request.immediate;
    wasActive.current = active;
    retire();
    const current = generation.current;
    setNextCursor(null);
    setLoading(active);
    setLoadingMore(false);
    if (!active) return;
    setFailure(null);
    const run = () => {
      if (current !== generation.current) return;
      const controller = new AbortController();
      abort.current = controller;
      void search({ q: request.query, cursor: null, signal: controller.signal }).then(
        (result) => {
          if (current !== generation.current || controller.signal.aborted) return;
          abort.current = null;
          setLoading(false);
          if (result.kind === "handled") return;
          if (result.kind === "page") {
            installed.current = {
              generation: current,
              query: request.query,
              cursor: result.page.page.next_cursor,
            };
            setResults(result.page.data);
            setResultsQuery(request.query);
            setNextCursor(result.page.page.next_cursor);
          } else {
            setResults([]);
            setFailure({ failure: result.failure, during: "search" });
          }
        },
      );
    };
    let timer: number | null = null;
    if (immediate || request.query === "") {
      run();
    } else {
      timer = window.setTimeout(run, QUERY_DELAY_MS);
    }
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      retire();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: request is the search input; search is a fresh transport closure and retire only invalidates stable refs.
  }, [active, request]);

  function loadMore() {
    const page = installed.current;
    if (
      !active ||
      page === null ||
      page.cursor === null ||
      page.query !== requestedQuery.current ||
      page.generation !== generation.current ||
      abort.current !== null
    ) return;
    const controller = new AbortController();
    abort.current = controller;
    setLoadingMore(true);
    setFailure(null);
    void search({ q: page.query, cursor: page.cursor, signal: controller.signal }).then(
      (result) => {
        if (
          page !== installed.current ||
          page.generation !== generation.current ||
          controller.signal.aborted
        ) return;
        abort.current = null;
        setLoadingMore(false);
        if (result.kind === "handled") return;
        if (result.kind === "page") {
          setResults((prior) => {
            const seen = new Set(prior.map((destination) => destination.id));
            return [...prior, ...result.page.data.filter((d) => !seen.has(d.id))];
          });
          installed.current = { ...page, cursor: result.page.page.next_cursor };
          setNextCursor(result.page.page.next_cursor);
        } else {
          setFailure({ failure: result.failure, during: "more" });
        }
      },
    );
  }

  return {
    query,
    setQuery,
    normalizedQuery,
    results,
    resultsQuery,
    nextCursor,
    loading,
    loadingMore,
    failure: failure?.failure ?? null,
    retry: () => {
      if (!active) return;
      if (failure?.during === "more") loadMore();
      else requestSearch({ query: requestedQuery.current, immediate: true });
    },
    loadMore,
  };
}
