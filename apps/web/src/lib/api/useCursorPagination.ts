"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { AsyncResource } from "@/lib/api/useResource";
import { isAbortError } from "@/lib/errors";

export interface CursorPage<T> {
  data: T[];
  page: { has_more: boolean; next_cursor: string | null };
}

interface CursorContinuation<T> {
  readonly owner: CursorPage<T> | null;
  readonly appended: T[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly error: ApiError | null;
}

// One owner for the "page 1 via useResource, then append more pages by cursor"
// pane pattern (CT-1). page-1 items+cursor derive from `firstPage`; later pages
// accumulate in local state, reset whenever the page-1 data reference changes.
export function useCursorPagination<T>(args: {
  firstPage: AsyncResource<CursorPage<T>>;
  initialMoreError: ApiError | null;
  loadMorePage: (cursor: string, signal: AbortSignal) => Promise<CursorPage<T>>;
}): {
  items: T[];
  status: "loading" | "error" | "ready";
  error: ApiError | null;
  hasMore: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
} {
  const { firstPage, initialMoreError, loadMorePage } = args;
  const firstData = firstPage.status === "ready" ? firstPage.data : null;

  const [continuation, setContinuation] = useState<CursorContinuation<T>>({
    owner: null,
    appended: [],
    nextCursor: null,
    loadingMore: false,
    error: initialMoreError,
  });
  const [defect, setDefect] = useState<{
    readonly owner: CursorPage<T>;
    readonly error: unknown;
  } | null>(null);

  // A new first page projects synchronously from its own cursor. The effect
  // adopts all continuation fields in one state update so an immediately
  // clickable control can never observe a new owner with the old cursor.
  const firstDataIsCurrent =
    firstData !== null && continuation.owner === firstData;
  const effectiveCursor =
    firstData === null
      ? null
      : firstDataIsCurrent
        ? continuation.nextCursor
        : firstData.page.next_cursor;
  const items = useMemo(() => {
    if (firstData === null) {
      return [];
    }
    return [
      ...firstData.data,
      ...(firstDataIsCurrent ? continuation.appended : []),
    ];
  }, [continuation.appended, firstData, firstDataIsCurrent]);

  useEffect(() => {
    if (firstData === null || continuation.owner === firstData) {
      return;
    }
    setContinuation({
      owner: firstData,
      appended: [],
      nextCursor: firstData.page.next_cursor,
      loadingMore: false,
      error: initialMoreError,
    });
  }, [continuation.owner, firstData, initialMoreError]);

  const cursorRef = useRef(effectiveCursor);
  cursorRef.current = effectiveCursor;
  const firstDataRef = useRef(firstData);
  firstDataRef.current = firstData;
  const loadingRef = useRef(false);
  const loadRef = useRef(loadMorePage);
  loadRef.current = loadMorePage;

  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  useEffect(() => () => abortRef.current?.abort(), []);

  useLayoutEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    loadingRef.current = false;
  }, [firstData]);

  const loadMore = useCallback(() => {
    const next = cursorRef.current;
    if (next === null || loadingRef.current) return;
    const generation = generationRef.current;
    loadingRef.current = true;
    setContinuation((current) => ({
      ...current,
      loadingMore: true,
      error: null,
    }));
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    void (async () => {
      try {
        const page = await loadRef.current(next, controller.signal);
        if (controller.signal.aborted || generation !== generationRef.current)
          return;
        setContinuation((current) => ({
          ...current,
          appended: [...current.appended, ...page.data],
          nextCursor: page.page.next_cursor,
        }));
      } catch (err) {
        if (
          isAbortError(err) ||
          controller.signal.aborted ||
          generation !== generationRef.current
        ) {
          return;
        }
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          const owner = firstDataRef.current;
          if (owner !== null) setDefect({ owner, error: err });
          return;
        }
        setContinuation((current) => ({
          ...current,
          error: err,
        }));
      } finally {
        if (
          !controller.signal.aborted &&
          generation === generationRef.current
        ) {
          loadingRef.current = false;
          setContinuation((current) => ({
            ...current,
            loadingMore: false,
          }));
        }
      }
    })();
  }, []);

  if (defect !== null && defect.owner === firstData) throw defect.error;

  switch (firstPage.status) {
    case "idle":
    case "loading":
      return {
        items: [],
        status: "loading",
        error: null,
        hasMore: false,
        nextCursor: null,
        loadingMore: false,
        loadMore,
        retry: () => {},
      };
    case "error":
      return {
        items: [],
        status: "error",
        error: firstPage.error,
        hasMore: false,
        nextCursor: null,
        loadingMore: false,
        loadMore,
        retry: firstPage.retry,
      };
    case "ready":
      return {
        items,
        status: "ready",
        error: firstDataIsCurrent ? continuation.error : null,
        hasMore: effectiveCursor !== null,
        nextCursor: effectiveCursor,
        loadingMore: firstDataIsCurrent ? continuation.loadingMore : false,
        loadMore,
        retry: loadMore,
      };
  }
}
