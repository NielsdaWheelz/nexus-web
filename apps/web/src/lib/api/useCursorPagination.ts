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
import { absent, type Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { AsyncResource } from "@/lib/api/useResource";
import { isAbortError } from "@/lib/errors";

export interface CursorPage<T, Cursor extends string = string> {
  readonly items: readonly T[];
  readonly nextCursor: Presence<Cursor>;
}

interface CursorContinuation<T, Cursor extends string> {
  readonly owner: CursorPage<T, Cursor> | null;
  readonly appended: T[];
  readonly nextCursor: Presence<Cursor>;
  readonly loadingMore: boolean;
  readonly error: ApiError | null;
}

// One owner for the "page 1 via useResource, then append more pages by cursor"
// pane pattern. page-1 items+cursor derive from `firstPage`; later pages
// accumulate in local state, reset whenever the page-1 data reference changes.
export function useCursorPagination<T, Cursor extends string = string>(args: {
  firstPage: AsyncResource<CursorPage<T, Cursor>>;
  initialMoreError: ApiError | null;
  loadMoreEnabled?: boolean;
  loadMorePage: (cursor: Cursor, signal: AbortSignal) => Promise<CursorPage<T, Cursor>>;
}): {
  items: T[];
  status: "loading" | "error" | "ready";
  error: ApiError | null;
  hasMore: boolean;
  nextCursor: Presence<Cursor>;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
} {
  const { firstPage, initialMoreError, loadMorePage, loadMoreEnabled = true } = args;
  const firstData = firstPage.status === "ready" ? firstPage.data : null;

  const [continuation, setContinuation] = useState<CursorContinuation<T, Cursor>>({
    owner: null,
    appended: [],
    nextCursor: absent(),
    loadingMore: false,
    error: initialMoreError,
  });
  const [defect, setDefect] = useState<{
    readonly owner: CursorPage<T, Cursor>;
    readonly error: unknown;
  } | null>(null);

  // A new first page projects synchronously from its own cursor. The effect
  // adopts all continuation fields in one state update so an immediately
  // clickable control can never observe a new owner with the old cursor.
  const firstDataIsCurrent =
    firstData !== null && continuation.owner === firstData;
  const effectiveCursor =
    firstData === null
      ? absent<Cursor>()
      : firstDataIsCurrent
        ? continuation.nextCursor
        : firstData.nextCursor;
  const items = useMemo(() => {
    if (firstData === null) {
      return [];
    }
    return [
      ...firstData.items,
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
      nextCursor: firstData.nextCursor,
      loadingMore: false,
      error: initialMoreError,
    });
  }, [continuation.owner, firstData, initialMoreError]);

  const cursorRef = useRef(effectiveCursor);
  cursorRef.current = effectiveCursor;
  const firstDataRef = useRef(firstData);
  firstDataRef.current = firstData;
  const loadingRef = useRef(false);
  const enabledRef = useRef(loadMoreEnabled);
  enabledRef.current = loadMoreEnabled;
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
    setContinuation((current) => current.loadingMore ? { ...current, loadingMore: false } : current);
  }, [firstData, loadMoreEnabled]);

  const loadMore = useCallback(() => {
    const next = cursorRef.current;
    if (!enabledRef.current || next.kind === "Absent" || loadingRef.current) return;
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
        const page = await loadRef.current(next.value, controller.signal);
        if (controller.signal.aborted || generation !== generationRef.current)
          return;
        setContinuation((current) => ({
          ...current,
          appended: [...current.appended, ...page.items],
          nextCursor: page.nextCursor,
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
        nextCursor: absent(),
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
        nextCursor: absent(),
        loadingMore: false,
        loadMore,
        retry: firstPage.retry,
      };
    case "ready":
      return {
        items,
        status: "ready",
        error: firstDataIsCurrent ? continuation.error : null,
        hasMore: effectiveCursor.kind === "Present",
        nextCursor: effectiveCursor,
        loadingMore: firstDataIsCurrent ? continuation.loadingMore : false,
        loadMore,
        retry: loadMore,
      };
  }
}
