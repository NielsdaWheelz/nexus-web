"use client";

// Server state for the podcast and browse panes (docs/modules/podcast.md).
// useServerValue holds one resource; useServerList holds a server-ordered
// collection with manual load-more. Both load on key, refetch when `stale`
// changes, coalesce refetches (one queued at most, never aborting the run in
// flight), restore this pane visit's snapshot and throw defects in render.

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import type { PaneRefreshExecute } from "@/lib/panes/panePublications";
import {
  podcastRefreshRequestAnnouncement,
  requestPodcastRefresh,
  type PodcastRefreshScope,
} from "@/lib/podcasts/api";
import {
  usePaneVisitData,
  type PaneVisitDataKey,
} from "@/lib/workspace/paneReturnMemento";

export interface ServerPage<T> {
  readonly items: readonly T[];
  readonly collectionRevision: number;
  readonly nextCursor: Presence<string>;
}
export interface Visit<T> {
  readonly key: string;
  readonly data: T;
}
export interface ListData<T> {
  readonly items: readonly T[];
  readonly next: { readonly cursor: string; readonly revision: number } | null;
  readonly want: number;
}
type Unready =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: ApiError };
export type ServerValue<T> = (
  | Unready
  | {
      readonly status: "ready";
      readonly data: T;
      readonly generation: number;
      readonly error: ApiError | null;
    }
) & { readonly refetch: () => void };
export type ServerList<T> = (
  | Unready
  | {
      readonly status: "ready";
      readonly items: readonly T[];
      readonly complete: boolean;
      readonly loadingMore: boolean;
      readonly error: ApiError | null;
    }
) & {
  readonly refetch: () => void;
  readonly loadMore: () => void;
  /** Repeats what failed: the load-more, or the load. */
  readonly retry: () => void;
};

type Step<D> = (current: D | null, signal: AbortSignal) => Promise<D>;
type Defect = { readonly error: unknown };
interface Held<D> {
  readonly key: string | null;
  readonly data: D | null;
  readonly generation: number;
  readonly error: ApiError | null;
  readonly failed: "Load" | "More";
  readonly running: boolean;
}

/** Rethrows an async defect during the next render, at the pane boundary. */
export function useThrowLater(): (defect: Defect) => void {
  const [defect, setDefect] = useState<Defect | null>(null);
  if (defect !== null) throw defect.error;
  return setDefect;
}

/** The modeled ApiError; null after an abort, a 401 or a defect. */
export function modeledApiError(
  error: unknown,
  fail: (defect: Defect) => void,
): ApiError | null {
  if (isAbortError(error) || handleUnauthenticatedApiError(error)) return null;
  if (isApiError(error) && !isSameSystemApiDefect(error)) return error;
  fail({ error });
  return null;
}

function arrive<D>(key: string | null, restored: Visit<D> | null): Held<D> {
  const data = restored?.key === key ? restored.data : null;
  return {
    key,
    data,
    generation: 0,
    error: null,
    failed: "Load",
    running: key !== null,
  };
}

/**
 * This visit's snapshot until the first arrival at another key: a snapshot
 * serves the one arrival it was captured for (a null key waits).
 */
export function useVisitSnapshot<V extends { readonly key: string }>(
  visit: PaneVisitDataKey<V>,
  key: string | null,
  capture: () => V | null,
): V | null {
  const sample = usePaneVisitData(visit, capture);
  const kept = useRef({ sample, live: sample });
  if (kept.current.sample !== sample) kept.current = { sample, live: sample };
  if (key !== null && kept.current.live?.key !== key) kept.current.live = null;
  return kept.current.live;
}

function useServerState<D>(
  key: string | null,
  stale: string,
  visit: PaneVisitDataKey<Visit<D>>,
  load: Step<D>,
) {
  const fail = useThrowLater();
  const heldRef = useRef<Held<D> | null>(null);
  const restored = useVisitSnapshot(
    visit,
    key,
    useCallback(() => {
      const held = heldRef.current;
      return held?.key && held.data !== null
        ? { key: held.key, data: held.data }
        : null;
    }, []),
  );
  const [state, setState] = useState(() => arrive(key, restored));
  const held = state.key === key ? state : arrive(key, restored);
  heldRef.current = held;
  const loadRef = useRef(load);
  loadRef.current = load;
  const flight = useRef<{ controller: AbortController; queued: boolean }>(null);

  const run = useCallback(
    async (runKey: string, first: Step<D>, kind: Held<D>["failed"]) => {
      const controller = new AbortController();
      const current = { controller, queued: true };
      flight.current = current;
      // A retried first load shows progress again, not its last failure.
      setState((h) => ({
        ...h,
        running: true,
        error: h.data === null ? null : h.error,
      }));
      let data = heldRef.current?.key === runKey ? heldRef.current.data : null;
      let step = first;
      try {
        while (current.queued) {
          current.queued = false;
          const from = data;
          try {
            data = await requestWithRetry(
              (signal) => step(from, signal),
              controller.signal,
            );
            const next = data;
            if (controller.signal.aborted) return;
            setState((h) => ({
              ...h,
              data: next,
              error: null,
              failed: "Load",
              generation: h.generation + 1,
            }));
          } catch (error) {
            if (controller.signal.aborted) return;
            const modeled = modeledApiError(error, fail);
            if (modeled === null) return;
            setState((h) => ({ ...h, error: modeled, failed: kind }));
          }
          step = loadRef.current;
          kind = "Load";
        }
      } finally {
        if (flight.current === current) {
          flight.current = null;
          setState((h) => ({ ...h, running: false }));
        }
      }
    },
    [fail],
  );

  useEffect(() => {
    setState((h) => (h.key === key ? h : arrive(key, restored)));
    if (key === null) return;
    void run(key, loadRef.current, "Load");
    return () => {
      flight.current?.controller.abort();
      flight.current = null;
    };
  }, [key, restored, run]);

  const refetch = useCallback(() => {
    if (flight.current !== null) flight.current.queued = true;
    else if (heldRef.current?.key) {
      void run(heldRef.current.key, loadRef.current, "Load");
    }
  }, [run]);

  const staleRef = useRef({ key, stale });
  useEffect(() => {
    const previous = staleRef.current;
    staleRef.current = { key, stale };
    if (previous.key === key && previous.stale !== stale) refetch();
  }, [key, stale, refetch]);

  /** Runs `step` once when nothing is in flight; a failure retries it. */
  const extend = (step: Step<D>) => {
    if (flight.current === null && key !== null) void run(key, step, "More");
  };
  return { held, refetch, extend };
}

export function useServerValue<T>(input: {
  readonly key: string | null;
  readonly stale: string;
  readonly visit: PaneVisitDataKey<Visit<T>>;
  readonly load: (signal: AbortSignal) => Promise<T>;
}): ServerValue<T> {
  const { held, refetch } = useServerState<T>(
    input.key,
    input.stale,
    input.visit,
    (_, signal) => input.load(signal),
  );
  if (held.data === null) {
    return held.error === null
      ? { status: "loading", refetch }
      : { status: "failed", error: held.error, refetch };
  }
  const { data, generation, error } = held;
  return { status: "ready", data, generation, error, refetch };
}

function pageQuery<T>(next: ListData<T>["next"], limit: number) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (next !== null) {
    query.set("cursor", next.cursor);
    query.set("collection_revision", String(next.revision));
  }
  return query;
}

function nextOf<T>(page: ServerPage<T>): ListData<T>["next"] {
  return page.nextCursor.kind === "Present"
    ? { cursor: page.nextCursor.value, revision: page.collectionRevision }
    : null;
}

const collectionChanged = (error: unknown) =>
  isApiError(error) && error.code === "E_COLLECTION_CHANGED";

export function useServerList<T>(input: {
  readonly key: string | null;
  readonly stale: string;
  readonly pageSize: number;
  readonly visit: PaneVisitDataKey<Visit<ListData<T>>>;
  readonly fetchPage: (
    page: URLSearchParams,
    signal: AbortSignal,
  ) => Promise<ServerPage<T>>;
}): ServerList<T> {
  const { pageSize, fetchPage } = input;
  // A prefix load of `want` rows; the continuation pair is echoed as issued.
  // One changed collection restarts the prefix once; a second one throws.
  const { held, refetch, extend } = useServerState<ListData<T>>(
    input.key,
    input.stale,
    input.visit,
    async (current, signal) => {
      const want = current?.want ?? pageSize;
      for (let restarted = false; ; restarted = true) {
        try {
          const items: T[] = [];
          let next: ListData<T>["next"] = null;
          do {
            const limit = Math.min(200, want - items.length);
            const page = await fetchPage(pageQuery(next, limit), signal);
            items.push(...page.items);
            next = nextOf(page);
          } while (next !== null && items.length < want);
          return { items, next, want };
        } catch (error) {
          if (restarted || !collectionChanged(error)) throw error;
        }
      }
    },
  );
  const data = held.data;
  // A changed collection reloads the prefix one page longer instead.
  const loadMore = () => {
    if (data?.next == null) return;
    const { next, items, want } = data;
    extend(async (_, signal) => {
      try {
        const page = await fetchPage(pageQuery(next, pageSize), signal);
        const all = [...items, ...page.items];
        return { items: all, next: nextOf(page), want: want + pageSize };
      } catch (error) {
        if (!collectionChanged(error)) throw error;
        refetch();
        return { ...data, want: want + pageSize };
      }
    });
  };
  const retry = held.failed === "More" ? loadMore : refetch;
  const actions = { refetch, loadMore, retry };
  if (data === null) {
    return held.error === null
      ? { status: "loading", ...actions }
      : { status: "failed", error: held.error, ...actions };
  }
  return {
    status: "ready",
    items: data.items,
    complete: data.next === null,
    loadingMore: held.running,
    error: held.error,
    ...actions,
  };
}

/** A local filter's row status over a list's loaded rows (one unit). */
export function listRowStatus(
  status: ServerList<unknown>["status"],
  complete: boolean,
  loadedCount: number,
  visibleCount: number,
  singular: string,
): PaneFilterRowsStatus {
  const unit = { singular, plural: `${singular}s` };
  if (status === "failed") {
    return { kind: "Failed", visibleCount, loadedCount, unit };
  }
  return complete
    ? { kind: "Complete", visibleCount, totalCount: loadedCount, unit }
    : { kind: "Partial", visibleCount, loadedCount, unit };
}

/** Failure copy for podcast reads and commands; throws defects. */
export function podcastErrorMessage(
  error: unknown,
  title: string,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const transport = apiTransportFeedback(error, title);
  if (transport !== null) return transport;
  const content = (message: string): FeedbackContent => ({
    tone: "Danger",
    title,
    message,
    requestId: error.requestId,
  });
  switch (error.code) {
    case "E_NOT_FOUND":
    case "E_PODCAST_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND":
      return content("It isn’t available.");
    case "E_FORBIDDEN":
      return content("This account can’t do that.");
    case "E_CONFLICT":
    case "E_SELECTION_CHANGED":
    case "E_COLLECTION_CHANGED":
    case "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH":
      return content("It changed meanwhile. Review it, then retry.");
    case "E_INVALID_REQUEST":
      return content("This view or request isn’t valid.");
    case "E_MEDIA_NOT_READY":
      return content("It’s still preparing. Retry once it settles.");
    default:
      throw error;
  }
}

/** One command at a time; its modeled failure becomes `failure`. */
export function useCommand(): {
  readonly running: string | null;
  readonly failure: FeedbackContent | null;
  readonly run: (title: string, command: () => Promise<void>) => void;
} {
  const fail = useThrowLater();
  const [running, setRunning] = useState<string | null>(null);
  const [failed, setFailed] = useState<{
    readonly title: string;
    readonly error: ApiError;
  } | null>(null);
  const busy = useRef(false);
  const run = useCallback(
    (title: string, command: () => Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      setRunning(title);
      setFailed(null);
      void command()
        .catch((error: unknown) => {
          const modeled = modeledApiError(error, fail);
          if (modeled !== null) setFailed({ title, error: modeled });
        })
        .finally(() => {
          busy.current = false;
          setRunning(null);
        });
    },
    [fail],
  );
  const failure =
    failed === null ? null : podcastErrorMessage(failed.error, failed.title);
  return { running, failure, run };
}

/** The pane chrome's refresh: admit, then announce; panes refetch on bump. */
export function podcastRefresh(scope: PodcastRefreshScope): PaneRefreshExecute {
  return async ({ signal }) => {
    try {
      const count = await requestPodcastRefresh(scope, signal);
      const announcement = podcastRefreshRequestAnnouncement(count);
      return { kind: "Complete", announcement };
    } catch (error) {
      if (isAbortError(error) || !isApiError(error)) throw error;
      if (isSameSystemApiDefect(error)) throw error;
      handleUnauthenticatedApiError(error);
      return { kind: "Failed", announcement: "Podcast refresh failed" };
    }
  };
}
