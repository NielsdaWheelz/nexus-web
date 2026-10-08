"use client";

import { useCallback, useMemo, useState } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useCursorPagination, type CursorPage } from "@/lib/api/useCursorPagination";
import type { AsyncResource } from "@/lib/api/useResource";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import { searchResourceTargets, type ResourceTarget } from "@/lib/resources/resourceTargets";

export interface UseResourceTargetSearchArgs {
  query: string;
  schemes?: readonly ResourceScheme[];
  sourceRef?: string;
  excludeRefs?: readonly string[];
  limit?: number;
}

/** First-page debounce and continuation use the existing request owners. */
export function useResourceTargetSearch(args: UseResourceTargetSearchArgs) {
  const { query, schemes, sourceRef, excludeRefs, limit } = args;
  const trimmed = query.trim();
  const identity = trimmed.length === 0 ? null : JSON.stringify([
    trimmed, schemes ?? [], sourceRef ?? null, excludeRefs ?? [], limit ?? null,
  ]);
  const [retryTick, setRetryTick] = useState(0);
  const retryFirst = useCallback(() => setRetryTick((value) => value + 1), []);
  const first = useDebouncedFetch(
    identity === null ? null : `${identity}:${retryTick}`,
    (signal) => searchResourceTargets({ q: trimmed, schemes, sourceRef, excludeRefs, limit }, signal),
    { debounceMs: 200, identity },
  );
  const firstPage = useMemo<AsyncResource<CursorPage<ResourceTarget>>>(() => {
    if (identity === null) return { status: "idle" };
    if (first.dataIdentity === identity && first.data !== null) {
      return { status: "ready", data: {
        items: first.data.targets,
        nextCursor: first.data.nextCursor === null ? absent() : present(first.data.nextCursor),
      } };
    }
    if (first.errorIdentity === identity && first.error !== null) {
      if (!isApiError(first.error) || isSameSystemApiDefect(first.error)) throw first.error;
      return { status: "error", error: first.error, retry: retryFirst };
    }
    return { status: "loading" };
  }, [first.data, first.dataIdentity, first.error, first.errorIdentity, identity, retryFirst]);
  const page = useCursorPagination({
    firstPage,
    initialMoreError: null,
    loadMorePage: async (cursor, signal) => {
      const result = await searchResourceTargets({
        q: trimmed, schemes, sourceRef, excludeRefs, limit, cursor,
      }, signal);
      return { items: result.targets, nextCursor: result.nextCursor === null ? absent() : present(result.nextCursor) };
    },
  });
  return {
    targets: page.items,
    loading: identity !== null && page.status === "loading",
    error: page.error,
    hasMore: page.hasMore,
    loadingMore: page.loadingMore,
    loadMore: page.loadMore,
    retry: page.retry,
  };
}
