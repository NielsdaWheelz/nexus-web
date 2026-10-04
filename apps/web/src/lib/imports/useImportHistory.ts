"use client";

import { useMemo } from "react";
import type { ApiError } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import {
  useCursorPagination,
  type CursorPage,
} from "@/lib/api/useCursorPagination";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import { useImports } from "@/lib/imports/ImportsProvider";
import type { ImportRef } from "@/lib/imports/importRef";
import {
  fetchImportHistory,
  type HistoryEntry,
  type HistoryPage,
} from "@/lib/imports/importsClient";

export interface ImportHistoryResult {
  readonly entries: readonly HistoryEntry[];
  readonly status: "loading" | "error" | "ready";
  readonly error: ApiError | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

/**
 * The inspected import's recorded attempts, newest first, paged by its own
 * cursor. History is append-only evidence, so it is keyed to the observation
 * revision like the detail and never re-read on the five-second observation.
 */
export function useImportHistory(ref: ImportRef | null): ImportHistoryResult {
  const { observation } = useImports();
  const keyed = useResource<HistoryPage>({
    cacheKey: ref === null ? null : `${ref} history ${observation.revision}`,
    load: (signal) => {
      if (ref === null) throw new Error("Cannot read a history with no ref");
      return fetchImportHistory({ ref, cursor: absent(), signal });
    },
  });

  const data = keyed.status === "ready" ? keyed.data : null;
  const cursorPage = useMemo(
    () =>
      data === null
        ? null
        : { items: data.entries, nextCursor: data.next_cursor },
    [data],
  );
  const firstPage: AsyncResource<CursorPage<HistoryEntry>> =
    cursorPage === null
      ? keyed.status === "error"
        ? keyed
        : { status: "loading" }
      : { status: "ready", data: cursorPage };
  const pagination = useCursorPagination<HistoryEntry>({
    firstPage,
    initialMoreError: null,
    loadMorePage: async (cursor, signal) => {
      if (ref === null) throw new Error("Cannot page a history with no ref");
      const next = await fetchImportHistory({
        ref,
        cursor: present(cursor),
        signal,
      });
      return { items: next.entries, nextCursor: next.next_cursor };
    },
  });

  return {
    entries: pagination.items,
    status: pagination.status,
    error: pagination.error,
    hasMore: pagination.hasMore,
    loadingMore: pagination.loadingMore,
    loadMore: pagination.loadMore,
    retry: pagination.retry,
  };
}
