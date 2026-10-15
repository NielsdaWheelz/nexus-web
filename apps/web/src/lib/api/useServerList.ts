"use client";

// One server-ordered list (docs/architecture.md §8.12).
// - `key` names the view. A new key loads its first page; until it lands the
//   previous key's rows stay shown (`current: false`), then they swap at once.
// - Rows are deduped by `id`; the first occurrence wins.
// - `refetch()` rereads the loaded prefix (at least one page; a complete list
//   to its end, so it stays complete) and commits it at once. It runs after the
//   read in flight, never aborting it, and calls made meanwhile share one
//   reread. A change of `stale` under the same key refetches.
// - `drain` continues page by page to the end while `active` and the document
//   is visible, and stops at the first failure until `retry()`.
// - Rows are always kept. A continuation that fails in transport or with a 5xx
//   is a failure, never a defect.
// - A pane return paints this visit's snapshot and rereads it only if `stale`
//   moved since it was read; a server seed paints the first visit the same way.
// - Defects throw in render; aborts and 401s are not failures.

import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError, type ApiError } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import {
  modeledApiError,
  useThrowLater,
  useVisitSnapshot,
} from "@/lib/api/serverState";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import type { PaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";

export interface ListPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}
/** One key's committed rows, and the `stale` token they were read under. */
export interface ListSnapshot<T> {
  readonly key: string;
  readonly stale: string;
  readonly items: readonly T[];
  readonly cursor: string | null;
}
type Op = "Load" | "More" | "Refetch";
export interface ServerList<T> {
  readonly status: "loading" | "failed" | "ready";
  readonly items: readonly T[];
  readonly shownKey: string | null;
  /** The shown rows belong to the requested key. */
  readonly current: boolean;
  /** Current, and the server has no further rows (I7). */
  readonly complete: boolean;
  readonly running: Op | null;
  readonly failure: { readonly op: Op; readonly error: ApiError } | null;
  readonly more: () => void;
  /** Repeats what failed; a rejected cursor rereads instead. */
  readonly retry: () => void;
  readonly refetch: () => Promise<void>;
}

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

const NONE: readonly never[] = [];
const isVisible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";
const nextOf = (page: ListPage<unknown>) =>
  page.next_cursor;
const aborted = () => new DOMException("The list view changed", "AbortError");

function unique<T>(items: readonly T[], id: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = id(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function useServerList<T>(input: {
  readonly key: string | null;
  readonly stale: string;
  readonly pageSize: number;
  readonly drain: boolean;
  readonly active: boolean;
  readonly visit: PaneVisitDataKey<ListSnapshot<T>>;
  readonly seed?: { readonly key: string; readonly page: ListPage<T> } | null;
  readonly id: (item: T) => string;
  readonly fetchPage: (
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<ListPage<T>>;
}): ServerList<T> {
  const { key, stale } = input;
  const fail = useThrowLater();
  const latest = useRef(input);
  latest.current = input;
  const shownRef = useRef<ListSnapshot<T> | null>(null);
  const restored = useVisitSnapshot(
    input.visit,
    key,
    useCallback(() => shownRef.current, []),
  );
  const [shown, setShown] = useState<ListSnapshot<T> | null>(() => {
    if (restored !== null) return restored;
    const seed = input.seed;
    if (seed == null || seed.key !== key) return null;
    return { key, stale, items: seed.page.items, cursor: nextOf(seed.page) };
  });
  shownRef.current = shown;
  const [running, setRunning] = useState<Op | null>(null);
  const [failure, setFailure] = useState<ServerList<T>["failure"]>(null);
  const [visible, setVisible] = useState(isVisible);
  const flight = useRef<AbortController | null>(null);
  const waiters = useRef<Waiter[]>([]);

  const run = useCallback(
    function run(requested: Op) {
      const { key, stale, pageSize, fetchPage, id } = latest.current;
      const base = shownRef.current?.key === key ? shownRef.current : null;
      if (key === null || flight.current !== null) return;
      if (requested === "More" && base?.cursor == null) return;
      // A reread of a key with no rows yet is its first load.
      const op = requested === "Refetch" && base === null ? "Load" : requested;
      const settle = op === "More" ? [] : waiters.current.splice(0);
      const controller = new AbortController();
      flight.current = controller;
      setRunning(op);
      setFailure(null);
      const read = async (signal: AbortSignal) => {
        if (op === "More" && base !== null) {
          const page = await fetchPage(base.cursor, pageSize, signal);
          return {
            items: [...base.items, ...page.items],
            cursor: nextOf(page),
          };
        }
        const want = Math.max(pageSize, base?.items.length ?? 0);
        const toEnd = base !== null && base.cursor === null;
        const items: T[] = [];
        let cursor: string | null = null;
        do {
          const limit = toEnd ? 200 : Math.min(200, want - items.length);
          const page = await fetchPage(cursor, limit, signal);
          items.push(...page.items);
          cursor = nextOf(page);
        } while (cursor !== null && (toEnd || items.length < want));
        return { items, cursor };
      };
      void requestWithRetry(read, controller.signal)
        .then(
          ({ items, cursor }) => {
            if (controller.signal.aborted) throw aborted();
            const next = { key, stale, items: unique(items, id), cursor };
            shownRef.current = next;
            setShown(next);
            for (const waiter of settle) waiter.resolve();
          },
          (error: unknown) => {
            if (controller.signal.aborted) throw aborted();
            // A continuation the server or network failed stops the list, not the pane.
            const modeled =
              op === "More" &&
              isApiError(error) &&
              (error.status === 0 || error.status >= 500)
                ? error
                : modeledApiError(error, fail);
            if (modeled !== null) setFailure({ op, error: modeled });
            for (const waiter of settle) waiter.reject(error);
          },
        )
        .catch((error: unknown) => {
          for (const waiter of settle) waiter.reject(error);
        })
        .finally(() => {
          if (flight.current !== controller) return;
          flight.current = null;
          setRunning(null);
          if (waiters.current.length > 0) run("Refetch");
        });
    },
    [fail],
  );

  const refetch = useCallback((): Promise<void> => {
    if (latest.current.key === null) return Promise.reject(aborted());
    return new Promise<void>((resolve, reject) => {
      waiters.current.push({ resolve, reject });
      run("Refetch");
    });
  }, [run]);

  useEffect(() => {
    if (key === null) return;
    const queue = waiters.current;
    const kept = shownRef.current;
    if (kept?.key !== key) run("Load");
    else if (kept.stale !== latest.current.stale) run("Refetch");
    return () => {
      flight.current?.abort();
      flight.current = null;
      for (const waiter of queue.splice(0)) waiter.reject(aborted());
      setRunning(null);
      setFailure(null);
    };
  }, [key, run]);

  const seen = useRef({ key, stale });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { key, stale };
    if (previous.key === key && previous.stale !== stale) {
      refetch().catch(() => {});
    }
  }, [key, stale, refetch]);

  useEffect(() => {
    if (!input.drain) return;
    const update = () => setVisible(isVisible());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [input.drain]);

  const ofKey = shown !== null && shown.key === key ? shown : null;
  const drainable =
    input.drain &&
    input.active &&
    visible &&
    ofKey?.cursor != null &&
    running === null &&
    failure === null;
  useEffect(() => {
    if (drainable) run("More");
  }, [drainable, shown, run]);

  return {
    status: shown !== null ? "ready" : failure !== null ? "failed" : "loading",
    items: shown?.items ?? NONE,
    shownKey: shown?.key ?? null,
    current: ofKey !== null,
    complete: ofKey !== null && ofKey.cursor === null,
    running,
    failure,
    more: () => run("More"),
    retry: () => {
      if (failure?.op === "More" && failure.error.code !== "E_INVALID_CURSOR") {
        run("More");
      } else if (failure !== null) {
        refetch().catch(() => {});
      }
    },
    refetch,
  };
}

/** A list's own query (`"sort=…&…"`) plus the page keys. */
export function pageQuery(
  query: string,
  cursor: string | null,
  limit: number,
): URLSearchParams {
  const params = new URLSearchParams(query);
  params.set("limit", String(limit));
  if (cursor !== null) params.set("cursor", cursor);
  return params;
}

/** The filter bar's status: `loadedCount` rows shown of the list, `visibleCount` matching. */
export function listRowStatus(
  list: ServerList<unknown>,
  loadedCount: number,
  visibleCount: number,
  unit: { readonly singular: string; readonly plural: string },
): PaneFilterRowsStatus {
  if (list.status === "ready" && !list.current) {
    const cause = list.failure === null ? "Updating" : "Failed";
    return { kind: "Retained", visibleCount, loadedCount, unit, cause };
  }
  if (list.status === "failed" || list.failure?.op === "More") {
    return { kind: "Failed", visibleCount, loadedCount, unit };
  }
  return list.complete
    ? { kind: "Complete", visibleCount, totalCount: loadedCount, unit }
    : { kind: "Partial", visibleCount, loadedCount, unit };
}
