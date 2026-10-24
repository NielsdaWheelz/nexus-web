"use client";

// One server-ordered list (docs/architecture.md §8.12).
// - `key` names the view. Only its matching, account-owned snapshot is
//   exposed; a new key loads with no previous-key rows or metadata.
// - Rows are deduped by `id`; the first occurrence wins.
// - `refetch()` rereads the loaded prefix (at least one page; a complete list
//   to its end, so it stays complete) and commits it at once. It runs after the
//   read in flight, superseding its success or failure, and calls made meanwhile
//   share one reread. A change of `stale` under the same key refetches.
// - Each page commits immediately, then continuation runs sequentially while
//   `active` and the document is visible; settled failure requires `retry()`.
//   Failure latches for this mounted read owner; snapshots retain data only.
//   A remount has fresh admission under its existing route/open/query owner.
// - `revalidate()` coalesces periodic observations behind traversal and strict
//   refresh. It never supersedes a read or clears a settled failure.
// - Same-key refresh and continuation failures keep the committed rows.
//   A continuation that fails in transport or with a 5xx is a failure, never a defect.
// - A pane return paints this visit's snapshot and rereads it only if `stale`
//   moved since it was read; a server seed for the first key paints the first
//   visit without a read. usePaneFreeServerList is the same list for a dialog
//   no pane visit owns.
// - Defects throw in render; aborts and 401s are not failures.

import { remoteReady } from "@/lib/native/admission";
import { useRemoteGeneration } from "@/lib/native/admissionHooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isApiError, ApiError } from "@/lib/api/client";
import {
  modeledApiError,
  requestWithRetry,
  useServerSeed,
  useReadOwner,
  useThrowLater,
  useVisitSnapshot,
} from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import type { PaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";

export interface ListPage<T, M = null> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly order_revision?: string | null;
  readonly metadata?: M | null;
}
/** One key's committed rows, and the `stale` token they were read under. */
export interface ListSnapshot<T, M = null> {
  readonly key: string;
  readonly stale: string;
  readonly items: readonly T[];
  readonly cursor: string | null;
  /** Consumed page cursors preserve exact prefix coverage, even for empty pages. */
  readonly cursors: readonly (string | null)[];
  readonly orderRevision: string | null;
  readonly metadata: M | null;
}
type Op = "Load" | "More" | "Refetch";
export interface ServerList<T, M = null> {
  /** Requested query identity, including null while no query is admitted. */
  readonly requestedKey: string | null;
  readonly status: "loading" | "failed" | "ready";
  readonly items: readonly T[];
  /** The requested key has a committed snapshot. */
  readonly current: boolean;
  /** That snapshot matches the current invalidation token; running and failure still gate intent. */
  readonly fresh: boolean;
  /** Current, and the server has no further rows (I7). */
  readonly complete: boolean;
  readonly orderRevision: string | null;
  /** Current-key metadata from the latest committed response, including an empty page. */
  readonly metadata: M | null;
  readonly running: Op | null;
  readonly failure: { readonly op: Op; readonly error: ApiError } | null;
  /** Input activity and document visibility; admitted reads may finish inactive. */
  readonly active: boolean;
  readonly revalidate: () => void;
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

interface ListInput<T, M> {
  readonly key: string | null;
  readonly stale: string;
  readonly pageSize: number;
  readonly readPolicy?: string;
  readonly active: boolean;
  readonly id: (item: T) => string;
  readonly fetchPage: (
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<ListPage<T, M>>;
}

export function useServerList<T, M = null>(
  input: ListInput<T, M> & { readonly visit: PaneVisitDataKey<ListSnapshot<T, M>> },
): ServerList<T, M> {
  const shownRef = useRef<ListSnapshot<T, M> | null>(null);
  const restored = useVisitSnapshot(
    input.visit,
    input.key,
    useCallback(() => shownRef.current, []),
  );
  return useList(input, restored, shownRef);
}

export function usePaneFreeServerList<T, M = null>(input: ListInput<T, M>): ServerList<T, M> {
  return useList(input, null, useRef<ListSnapshot<T, M> | null>(null));
}

function useList<T, M>(
  input: ListInput<T, M>,
  restored: ListSnapshot<T, M> | null,
  shownRef: { current: ListSnapshot<T, M> | null },
): ServerList<T, M> {
  const { key, stale } = input;
  const admissionGeneration = useRemoteGeneration();
  const accountId = useOptionalAuthenticatedAccount()?.accountId ?? null;
  const [shownAccount, setShownAccount] = useState(accountId);
  const latestAccount = useRef(accountId);
  latestAccount.current = accountId;
  const fail = useThrowLater();
  const signIn = useUnauthenticatedApiHandler();
  const latest = useRef(input);
  latest.current = input;
  const seed = useServerSeed<ListPage<T, M>>(key);
  const [held, setShown] = useState<ListSnapshot<T, M> | null>(() => {
    if (restored !== null || seed === null) return restored;
    const { items, next_cursor, order_revision, metadata } = seed.data;
    return { key: seed.key, stale, items: unique(items, input.id), cursor: next_cursor, cursors: [null], orderRevision: order_revision ?? null, metadata: metadata ?? null };
  });
  const shown = shownAccount === accountId ? held : null;
  shownRef.current = shown;
  const [running, setRunning] = useState<Op | null>(null);
  const [failureAccount, setFailureAccount] = useState(accountId);
  const [heldFailure, setFailure] = useState<(NonNullable<ServerList<T, M>["failure"]> & { readonly key: string }) | null>(null);
  const failure = failureAccount === accountId && heldFailure?.key === key ? heldFailure : null;
  const pendingObservation = useRef(false);
  const [observation, setObservation] = useState(0);
  const [visible, setVisible] = useState(isVisible);
  const flight = useRef<AbortController | null>(null);
  const waiters = useRef<Waiter[]>([]);

  const owner = useReadOwner(key, `list:retry3:pageSize=${input.pageSize}:${input.readPolicy ?? ""}`, stale, () => {
    if (latest.current.key === null) return;
    waiters.current.push({ resolve() {}, reject() {} });
    run("Refetch");
  });
  const run = useCallback(
    function run(requested: Op) {
      const { key, stale, pageSize, fetchPage, id } = latest.current;
      const base = shownRef.current?.key === key ? shownRef.current : null;
      if (latestAccount.current !== accountId || key === null || flight.current !== null) return;
      if (!remoteReady()) {
        const error = new ApiError(0, "E_NETWORK", "this view needs a connection");
        setFailureAccount(accountId);
        setFailure(previous => previous?.key === key ? previous : { key, op: requested, error });
        for (const waiter of waiters.current.splice(0)) waiter.reject(error);
        return;
      }
      if (requested === "More" && base?.cursor == null) return;
      // A reread of a key with no rows yet is its first load.
      const op = requested === "Refetch" && base === null ? "Load" : requested;
      const settle = op === "More" ? [] : waiters.current.splice(0);
      if (op !== "More") pendingObservation.current = false;
      const generation = owner.generation;
      const controller = new AbortController();
      flight.current = controller;
      setRunning(op);
      const superseded = () => {
        if (latestAccount.current === accountId && generation === owner.generation && waiters.current.length === 0 && latest.current.key === key && latest.current.stale === stale) return false;
        // A caller awaiting this reread waits for the queued fresh one too.
        waiters.current.unshift(...settle);
        return true;
      };
      // The cursor restart budget encloses transport retries, not each attempt.
      let restarted = false;
      const wantPages = op === "Load" ? 1 : (base?.cursors.length ?? 1) + (op === "More" ? 1 : 0);
      const toEnd = op !== "Load" && base !== null && base.cursor === null;
      const read = async (signal: AbortSignal) => {
        const validateCursor = (page: ListPage<T, M>, cursors: readonly (string | null)[]) => {
          if (page.next_cursor !== null && cursors.includes(page.next_cursor)) {
            throw new ApiError(409, "E_INVALID_CURSOR", "list returned a repeated cursor");
          }
        };
        const walk = async () => {
          const items: T[] = [];
          const cursors: (string | null)[] = [];
          let cursor: string | null = null;
          let orderRevision: string | null = null;
          let metadata: M | null = null;
          do {
            const page = await fetchPage(cursor, pageSize, signal);
            cursors.push(cursor);
            validateCursor(page, cursors);
            metadata = page.metadata ?? null;
            const revision = page.order_revision ?? null;
            if (cursor === null) orderRevision = revision;
            else if (revision !== orderRevision) throw new Error("list pages returned different order revisions");
            items.push(...page.items);
            cursor = page.next_cursor;
          } while (cursor !== null && (toEnd || cursors.length < wantPages));
          return { items, cursor, cursors, orderRevision, metadata, continuation: false };
        };
        try {
          if (op === "More" && base !== null && !restarted) {
            const page = await fetchPage(base.cursor, pageSize, signal);
            const cursors = [...base.cursors, base.cursor];
            validateCursor(page, cursors);
            const orderRevision = page.order_revision ?? null;
            if (orderRevision !== base.orderRevision) throw new Error("list continuation returned a different order revision");
            return { items: page.items, cursor: page.next_cursor, cursors, orderRevision, metadata: page.metadata ?? null, continuation: true };
          }
          return await walk();
        } catch (error) {
          // Restart from the source, never from a cached first page.
          if (!isApiError(error) || error.code !== "E_INVALID_CURSOR" || restarted) throw error;
          restarted = true;
          return walk();
        }
      };
      const requestKey = JSON.stringify([op === "More" ? "more" : "prefix", wantPages,
        op === "More" ? base?.cursor : null, toEnd, base?.orderRevision]);
      void owner.read(requestKey, signal => requestWithRetry(read, signal), controller.signal)
        .then(
          ({ items, cursor, cursors, orderRevision, metadata, continuation }) => {
            if (controller.signal.aborted) throw aborted();
            if (superseded()) return;
            const next = { key, stale, items: unique(continuation && base !== null ? [...base.items, ...items] : items, id), cursor, cursors, orderRevision, metadata };
            shownRef.current = next;
            setFailure(null);
            setShownAccount(accountId);
            setShown(next);
            for (const waiter of settle) waiter.resolve();
          },
          (error: unknown) => {
            if (controller.signal.aborted) throw aborted();
            if (superseded()) return;
            // A continuation the server or network failed stops the list, not the pane.
            const modeled =
              op === "More" &&
              isApiError(error) &&
              (error.status === 0 || error.status >= 500)
                ? error
                : modeledApiError(error, fail, signIn);
            if (modeled !== null) {
              setFailureAccount(accountId);
              setFailure({ key, op, error: modeled });
            }
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
          if (latestAccount.current === accountId && waiters.current.length > 0) run("Refetch");
        });
    },
    [fail, shownRef, signIn, owner, accountId],
  );

  const refetch = useCallback((): Promise<void> => {
    if (latest.current.key === null) return Promise.reject(aborted());
    return new Promise<void>((resolve, reject) => {
      waiters.current.push({ resolve, reject });
      owner.invalidate();
    });
  }, [owner]);

  useEffect(() => {
    pendingObservation.current = false;
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
  }, [key, run, shownRef]);

  const admittedGeneration = useRef(admissionGeneration);
  useEffect(() => {
    if (admissionGeneration === admittedGeneration.current) return;
    admittedGeneration.current = admissionGeneration;
    if (remoteReady()) void refetch().catch(() => {});
  }, [admissionGeneration, refetch]);

  const revalidate = useCallback(() => {
    if (latest.current.key === null || pendingObservation.current) return;
    pendingObservation.current = true;
    setObservation((value) => value + 1);
  }, []);

  useEffect(() => {
    const update = () => setVisible(isVisible());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const ofKey = shown !== null && shown.key === key ? shown : null;
  const active = input.active && visible;
  useEffect(() => {
    if (!active || ofKey === null || running !== null || failure !== null) return;
    if (ofKey.cursor !== null) run("More");
    else if (pendingObservation.current) run("Refetch");
  }, [active, ofKey, running, failure, observation, run]);

  return {
    requestedKey: key,
    status: ofKey !== null ? "ready" : failure !== null ? "failed" : "loading",
    items: ofKey?.items ?? NONE,
    current: ofKey !== null,
    fresh: ofKey !== null && ofKey.stale === stale,
    complete: ofKey !== null && ofKey.cursor === null,
    orderRevision: ofKey?.orderRevision ?? null,
    metadata: ofKey?.metadata ?? null,
    running,
    failure,
    active,
    revalidate,
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
  list: ServerList<unknown, unknown>,
  loadedCount: number,
  visibleCount: number,
  unit: { readonly singular: string; readonly plural: string },
): PaneFilterRowsStatus {
  if (list.status === "failed" || list.failure?.op === "More") {
    return { kind: "Failed", visibleCount, loadedCount, unit };
  }
  return list.complete
    ? { kind: "Complete", visibleCount, totalCount: loadedCount, unit }
    : { kind: "Partial", visibleCount, loadedCount, unit };
}
