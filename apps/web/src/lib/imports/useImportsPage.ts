"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiError } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import {
  useCursorPagination,
  type CursorPage,
} from "@/lib/api/useCursorPagination";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import { useImports } from "@/lib/imports/ImportsProvider";
import { useLiveRereadFailure } from "@/lib/imports/liveReread";
import {
  fetchImportPage,
  type ImportItem,
  type ImportPage,
  type ImportStageGroup,
} from "@/lib/imports/importsClient";
import {
  importsQueryParams,
  type ImportsUrlState,
  type ImportsView,
} from "@/lib/imports/importsUrlState";

export interface ImportsPageResult {
  readonly items: readonly ImportItem[];
  readonly status: "loading" | "error" | "ready";
  readonly error: ApiError | null;
  readonly matchedCount: number;
  readonly groups: readonly ImportStageGroup[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

/**
 * What makes one decoded page the page already shown: its rows, exactly as
 * contract D10 words it. `observedAt` is a fact about the read rather than
 * about the work and the server stamps a new one on every read, so identical
 * rows must not be told apart by it — that would restart the continuation on
 * every five-second tick. The counts are not part of it either: work finishing
 * on a later page must not throw away the pages this reader loaded, and the
 * authoritative attention/active counts come from the provider's summary.
 */
function shownItems(page: ImportPage): string {
  return JSON.stringify(page.items);
}

function cursorPage(page: ImportPage): CursorPage<ImportItem> {
  return {
    data: [...page.items],
    page: {
      has_more: page.nextCursor.kind === "Present",
      next_cursor:
        page.nextCursor.kind === "Present" ? page.nextCursor.value : null,
    },
  };
}

/**
 * The filtered list of imports for one view: page one keyed to the query and the
 * provider's observation revision, later pages appended by cursor, and — while
 * work is active — a live re-read of page one on the provider's own five-second
 * observation. A re-read that decodes to the page already shown keeps the
 * previous page object, so the appended pages survive it; a different page
 * replaces it and the continuation restarts (contract D10).
 */
export function useImportsPage(
  view: ImportsView,
  state: ImportsUrlState,
): ImportsPageResult {
  const { observation, summary } = useImports();
  const absorbRereadFailure = useLiveRereadFailure();
  const query = importsQueryParams(view, state).toString();
  const cacheKey = `${query} ${observation.revision}`;
  const keyed = useResource<ImportPage>({
    cacheKey,
    load: (signal) =>
      fetchImportPage({
        query: new URLSearchParams(query),
        cursor: absent(),
        signal,
      }),
  });

  const [live, setLive] = useState<{
    readonly key: string;
    readonly page: ImportPage;
  } | null>(null);

  // A live page belongs to the key it was read for, so it is dropped as that
  // key leaves: returning to an earlier key (filters back and forth on one
  // revision) must never shadow the read that key is making now with a page
  // captured before the detour.
  const keyRef = useRef(cacheKey);
  if (keyRef.current !== cacheKey) {
    keyRef.current = cacheKey;
    if (live !== null) setLive(null);
  }

  const keyedPage = keyed.status === "ready" ? keyed.data : null;
  const page = live !== null && live.key === cacheKey ? live.page : keyedPage;

  const shownRef = useRef<{ readonly key: string; readonly page: ImportPage } | null>(
    null,
  );
  shownRef.current = page === null ? null : { key: cacheKey, page };
  const activeRef = useRef(0);
  activeRef.current = summary?.activeCount ?? 0;
  const queryRef = useRef(query);
  queryRef.current = query;

  // A new revision re-keys the read above, so the observation carrying it is
  // already answered by that read and must not read page one a second time.
  const rekeyedRef = useRef(false);
  const revisionRef = useRef(observation.revision);
  if (revisionRef.current !== observation.revision) {
    revisionRef.current = observation.revision;
    rekeyedRef.current = true;
  }

  // The provider's observation is the only clock here: a new `observedAt` is one
  // successful summary read, which is this pane's five-second tick.
  const observedAt = observation.observedAt;
  const lastObservedRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastObservedRef.current;
    lastObservedRef.current = observedAt;
    const shown = shownRef.current;
    // The provider's first observation is the read the keyed resource made.
    if (previous === null || previous === observedAt) return;
    if (rekeyedRef.current) {
      rekeyedRef.current = false;
      return;
    }
    if (shown === null || activeRef.current === 0) return;
    const controller = new AbortController();
    void (async () => {
      let next: ImportPage;
      try {
        next = await fetchImportPage({
          query: new URLSearchParams(queryRef.current),
          cursor: absent(),
          signal: controller.signal,
        });
      } catch (error: unknown) {
        absorbRereadFailure(error, controller.signal);
        return;
      }
      if (controller.signal.aborted) return;
      if (shownItems(next) === shownItems(shown.page)) return;
      setLive({ key: shown.key, page: next });
    })();
    return () => controller.abort();
  }, [absorbRereadFailure, observedAt]);

  const firstPage = useMemo<AsyncResource<CursorPage<ImportItem>>>(() => {
    if (page !== null) return { status: "ready", data: cursorPage(page) };
    if (keyed.status === "error") {
      return { status: "error", error: keyed.error, retry: keyed.retry };
    }
    return { status: "loading" };
  }, [keyed, page]);

  const pagination = useCursorPagination<ImportItem>({
    firstPage,
    initialMoreError: null,
    buildMoreHref: (cursor) => cursor,
    loadMorePage: async (cursor, signal) =>
      cursorPage(
        await fetchImportPage({
          query: new URLSearchParams(query),
          cursor: present(cursor),
          signal,
        }),
      ),
  });

  return {
    items: pagination.items,
    status: pagination.status,
    error: pagination.error,
    matchedCount: page?.matchedCount ?? 0,
    groups: page?.groups ?? [],
    hasMore: pagination.hasMore,
    loadingMore: pagination.loadingMore,
    loadMore: pagination.loadMore,
    retry: pagination.retry,
  };
}
