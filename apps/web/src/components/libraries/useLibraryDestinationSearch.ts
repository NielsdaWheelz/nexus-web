import { useEffect, useRef, useState } from "react";
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly LibraryDestination[]>([]);
  const [resultsQuery, setResultsQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<{
    failure: Failure;
    during: "search" | "more";
  } | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const wasActive = useRef(false);
  const lastRetryNonce = useRef(retryNonce);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const immediate =
      (active && !wasActive.current) || retryNonce !== lastRetryNonce.current;
    wasActive.current = active;
    lastRetryNonce.current = retryNonce;
    const current = ++generation.current;
    abort.current?.abort();
    abort.current = null;
    setLoadingMore(false);
    if (!active) return;
    const run = () => {
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      setFailure(null);
      // a new search supersedes the prior page's Load More until it commits
      setNextCursor(null);
      void search({ q: normalizedQuery, cursor: null, signal: controller.signal }).then(
        (result) => {
          if (current !== generation.current) return;
          setLoading(false);
          if (result.kind === "handled") return;
          if (result.kind === "page") {
            setResults(result.page.data);
            setResultsQuery(normalizedQuery);
            setNextCursor(result.page.page.next_cursor);
          } else {
            setResults([]);
            setFailure({ failure: result.failure, during: "search" });
          }
        },
      );
    };
    if (immediate || normalizedQuery === "") {
      run();
      return;
    }
    const timer = window.setTimeout(run, QUERY_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: `search` is the caller's transport, a fresh closure per render, not an input of the search state.
  }, [active, normalizedQuery, retryNonce]);

  function loadMore() {
    if (nextCursor === null || loadingMore) return;
    const current = generation.current;
    const controller = new AbortController();
    abort.current = controller;
    setLoadingMore(true);
    setFailure(null);
    void search({ q: resultsQuery, cursor: nextCursor, signal: controller.signal }).then(
      (result) => {
        if (current !== generation.current) return;
        setLoadingMore(false);
        if (result.kind === "handled") return;
        if (result.kind === "page") {
          setResults((prior) => {
            const seen = new Set(prior.map((destination) => destination.id));
            return [...prior, ...result.page.data.filter((d) => !seen.has(d.id))];
          });
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
    retry: () =>
      failure?.during === "more" ? loadMore() : setRetryNonce((nonce) => nonce + 1),
    loadMore,
  };
}
