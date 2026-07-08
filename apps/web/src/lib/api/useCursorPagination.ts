"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch, isApiError, type ApiPath } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { AsyncResource } from "@/lib/api/useResource";
import { isAbortError } from "@/lib/errors";

export interface CursorPage<T> {
  data: T[];
  page: { has_more: boolean; next_cursor: string | null };
}

// One owner for the "page 1 via useResource, then append more pages by cursor"
// pane pattern (CT-1). page-1 items+cursor derive from `firstPage`; later pages
// accumulate in local state, reset whenever the page-1 data reference changes.
export function useCursorPagination<T>(args: {
  firstPage: AsyncResource<CursorPage<T>>;
  buildMoreHref: (cursor: string) => string;
}): {
  items: T[];
  status: "loading" | "error" | "ready";
  error: ApiError | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
} {
  const { firstPage, buildMoreHref } = args;
  const firstData = firstPage.status === "ready" ? firstPage.data : null;

  const [appended, setAppended] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ApiError | null>(null);

  // Reset appended pages when page 1 changes identity (new firstPage.data ref).
  const seenRef = useRef<CursorPage<T> | null>(null);
  const firstDataIsCurrent = firstData !== null && seenRef.current === firstData;
  const effectiveCursor =
    firstData === null
      ? null
      : firstDataIsCurrent
        ? cursor
        : firstData.page.next_cursor;
  const items = useMemo(() => {
    if (firstData === null) {
      return [];
    }
    return [...firstData.data, ...(firstDataIsCurrent ? appended : [])];
  }, [appended, firstData, firstDataIsCurrent]);

  useEffect(() => {
    if (firstData === null || seenRef.current === firstData) {
      return;
    }
    seenRef.current = firstData;
    setAppended([]);
    setCursor(firstData.page.next_cursor);
    setLoadingMore(false);
    setMoreError(null);
  }, [firstData]);

  const cursorRef = useRef(effectiveCursor);
  cursorRef.current = effectiveCursor;
  const loadingRef = useRef(false);
  const buildRef = useRef(buildMoreHref);
  buildRef.current = buildMoreHref;

  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
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
    setLoadingMore(true);
    setMoreError(null);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    void (async () => {
      try {
        const page = await apiFetch<CursorPage<T>>(
          buildRef.current(next) as ApiPath,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setAppended((prev) => [...prev, ...page.data]);
        setCursor(page.page.next_cursor);
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        if (handleUnauthenticatedApiError(err)) return;
        setMoreError(
          isApiError(err)
            ? err
            : new ApiError(
                0,
                "E_NETWORK",
                err instanceof Error ? err.message : "Request failed",
              ),
        );
      } finally {
        if (!controller.signal.aborted && generation === generationRef.current) {
          loadingRef.current = false;
          setLoadingMore(false);
        }
      }
    })();
  }, []);

  switch (firstPage.status) {
    case "idle":
    case "loading":
      return {
        items: [],
        status: "loading",
        error: null,
        hasMore: false,
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
        loadingMore: false,
        loadMore,
        retry: firstPage.retry,
      };
    case "ready":
      return {
        items,
        status: "ready",
        error: firstDataIsCurrent ? moreError : null,
        hasMore: effectiveCursor !== null,
        loadingMore: firstDataIsCurrent ? loadingMore : false,
        loadMore,
        retry: loadMore,
      };
  }
}
