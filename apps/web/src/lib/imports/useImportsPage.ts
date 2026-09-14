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
  /**
   * The newest read of this query failed and the rows on screen are the ones
   * read before it. `status` stays `ready` in that case: the list is last-good
   * data, and only the freshness notice changes.
   */
  readonly refreshFailed: boolean;
  readonly refreshDefect: { readonly error: unknown } | null;
  readonly refreshKey: string;
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
  const [defect, setDefect] = useState<{ readonly key: string; readonly error: unknown } | null>(null);
  const keyed = useResource<ImportPage>({
    cacheKey,
    onDefect: (error) => setDefect({ key: cacheKey, error }),
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
  if (live !== null && live.key !== cacheKey) setLive(null);

  const keyedPage = keyed.status === "ready" ? keyed.data : null;
  const read = live !== null && live.key === cacheKey ? live.page : keyedPage;

  // An invalidation or a manual refresh re-keys the read above without changing
  // what is being asked for, and a re-keyed read has no data: the rows the
  // reader is looking at would unmount for one round trip. The page last read
  // for this exact query stands in until the new read answers, so a removal or
  // a recovery never empties the list it is refreshing. It stands in when that
  // read fails too — "Failed refresh keeps last-good data" — so a transport
  // failure never throws away rows the browser is still holding; only a query
  // with no page ever read for it has nothing to show.
  const lastGoodRef = useRef<{
    readonly query: string;
    readonly page: ImportPage;
  } | null>(null);
  if (read !== null) lastGoodRef.current = { query, page: read };
  const lastGood = lastGoodRef.current;
  const page =
    read ?? (lastGood !== null && lastGood.query === query ? lastGood.page : null);
  const refreshDefect = defect?.key === cacheKey ? defect : null;

  // The newest read of this query failed while the page above is the one read
  // before it: the reader is looking at facts, not at a failure, so the pane
  // says the refresh failed rather than replacing the list with an error.
  const refreshFailed = keyed.status === "error" && read === null && page !== null;

  // What the effect below re-reads: the page committed with the key it is
  // running for, since an effect runs against the render that scheduled it.
  const shownRef = useRef<ImportPage | null>(null);
  shownRef.current = page;
  const activeRef = useRef(0);
  activeRef.current = summary?.activeCount ?? 0;

  // The observation revision the shown page was read for. An observation that
  // moved the revision re-keyed the read above and is answered by that keyed
  // read alone, so it must not read page one a second time; every later
  // observation is this pane's five-second tick. Only the provider's revision
  // marks it: a query the reader changed re-keys the read too, and it is not an
  // observation, so it must not cost the reader a tick.
  const revision = observation.revision;
  const tickedRevisionRef = useRef(revision);

  // The provider's observation is the only clock here: a new `observedAt` is one
  // successful summary read, which is this pane's five-second tick.
  const observedAt = observation.observedAt;
  const lastObservedRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastObservedRef.current;
    lastObservedRef.current = observedAt;
    // The provider's first observation is the read the keyed resource made.
    if (previous === null || previous === observedAt) return;
    const ticked = tickedRevisionRef.current;
    tickedRevisionRef.current = revision;
    if (ticked !== revision) return;
    const shown = shownRef.current;
    if (shown === null || activeRef.current === 0) return;
    const controller = new AbortController();
    void (async () => {
      let next: ImportPage;
      try {
        next = await fetchImportPage({
          query: new URLSearchParams(query),
          cursor: absent(),
          signal: controller.signal,
        });
      } catch (error: unknown) {
        absorbRereadFailure(error, controller.signal);
        return;
      }
      if (controller.signal.aborted) return;
      if (shownItems(next) === shownItems(shown)) return;
      setLive({ key: cacheKey, page: next });
    })();
    return () => controller.abort();
  }, [absorbRereadFailure, cacheKey, observedAt, query, revision]);

  // The continuation is owned by the page object, so the projection of one page
  // must not be rebuilt while the reader is still on it: a re-keyed read hands
  // back a fresh resource object on every render until it answers.
  const firstData = useMemo(
    () => (page === null ? null : cursorPage(page)),
    [page],
  );
  const firstPage = useMemo<AsyncResource<CursorPage<ImportItem>>>(() => {
    if (firstData !== null) return { status: "ready", data: firstData };
    if (keyed.status === "error") {
      return { status: "error", error: keyed.error, retry: keyed.retry };
    }
    return { status: "loading" };
  }, [firstData, keyed]);

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

  // A failed initial read has no data to retain. A refresh has an independently
  // valid page; its freshness boundary reports the defect without unmounting it.
  if (refreshDefect !== null && page === null) throw refreshDefect.error;

  return {
    items: pagination.items,
    status: pagination.status,
    error: pagination.error,
    matchedCount: page?.matchedCount ?? 0,
    groups: page?.groups ?? [],
    hasMore: pagination.hasMore,
    loadingMore: pagination.loadingMore,
    refreshFailed,
    refreshDefect,
    refreshKey: cacheKey,
    loadMore: pagination.loadMore,
    retry: pagination.retry,
  };
}
