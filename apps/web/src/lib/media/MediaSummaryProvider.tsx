"use client";

// The tab's stored-media summaries, keyed by media id (J6). A list retains the summaries
// it shows, seeded from its own read; a mount reads its rows again, and retained ids are
// resolved again when consumption or bibliography changes and when the page returns to
// the screen (at most once a minute); ids whose resolve failed, also when the network
// returns. Resolves batch every retain of one commit, up to
// 100 ids, one request at a time. A change to an ordering fact (title, credits, first
// publication, status, duration) moves `queryRevision`, which lists put in their own
// read's stale token. An id no list retains is forgotten.
//
// Not useServerValue/useServerList: those own one keyed read each, while this batches one
// resolve across every mounted list and lets each list's own read seed and order it.

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { apiFetch, type ApiError } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { modeledApiError } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import type { MediaSummary } from "./mediaSummary";

interface Entry {
  summary: MediaSummary | null;
  error: ApiError | null;
  retained: number;
  stale: boolean;
  resolving: boolean;
}

function orderingFacts(summary: MediaSummary | null): string {
  if (summary === null) return "null";
  const { title, contributors, original_published_date, processing_status } =
    summary;
  const { duration } = summary;
  return JSON.stringify([
    title,
    contributors,
    original_published_date,
    processing_status,
    duration && [duration.modality, duration.estimate.total_minutes],
  ]);
}

function createStore() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let queryRevision = 0;
  let running = false;
  let scheduled = false;
  let active = true;
  let request: AbortController | null = null;
  let defect: { error: unknown } | null = null;

  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  const schedule = () => {
    if (!active || scheduled || running) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void resolve();
    });
  };

  async function resolve() {
    if (!active) return;
    const ids = [...entries]
      .filter(([, entry]) => entry.stale && entry.retained > 0)
      .map(([id]) => id)
      .slice(0, 100);
    if (ids.length === 0) return;
    const controller = new AbortController();
    request = controller;
    running = true;
    for (const id of ids) {
      const entry = entries.get(id)!;
      entry.stale = false;
      entry.resolving = true;
    }
    notify();
    try {
      const { data } = await apiFetch<
        ApiJson<"/media/summaries/resolve", "post">
      >("/api/media/summaries/resolve", {
        method: "POST",
        body: JSON.stringify({ media_ids: ids }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      for (const { media_id, summary } of data.items) {
        const entry = entries.get(media_id);
        // Released, or invalidated in flight: the next request reads it again.
        if (entry === undefined || entry.stale) continue;
        if (orderingFacts(entry.summary) !== orderingFacts(summary))
          queryRevision += 1;
        entry.summary = summary;
        entry.error = null;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const modeled = modeledApiError(error, (found) => {
        defect = found;
      });
      for (const id of ids) {
        const entry = entries.get(id);
        if (modeled !== null && entry !== undefined && !entry.stale)
          entry.error = modeled;
      }
    } finally {
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry !== undefined) entry.resolving = false;
      }
      running = false;
      request = null;
      if (active) notify();
      schedule();
    }
  }

  const invalidate = (ids: Iterable<string>) => {
    for (const id of ids) {
      const entry = entries.get(id);
      if (entry === undefined) continue;
      entry.stale = true;
    }
    notify();
    schedule();
  };

  const invalidateQueries = (ids: Iterable<string>) => {
    queryRevision += 1;
    invalidate(ids);
  };

  return {
    attach() {
      active = true;
      schedule();
      return () => {
        active = false;
        request?.abort();
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    revision: () => revision,
    queryRevision: () => queryRevision,
    retain(seeds: readonly MediaSummary[]) {
      const ids = [...new Set(seeds.map((seed) => seed.media_id))];
      for (const seed of seeds) {
        if (!entries.has(seed.media_id))
          entries.set(seed.media_id, {
            summary: seed,
            error: null,
            retained: 0,
            stale: true,
            resolving: false,
          });
      }
      for (const id of ids) entries.get(id)!.retained += 1;
      invalidate(ids);
      return () => {
        for (const id of ids) {
          const entry = entries.get(id)!;
          entry.retained -= 1;
          if (entry.retained === 0) entries.delete(id);
        }
      };
    },
    resolve: (seed: MediaSummary): MediaSummary | null => {
      const entry = entries.get(seed.media_id);
      return entry === undefined ? seed : entry.summary;
    },
    error(ids: readonly string[]): ApiError | null {
      if (defect !== null) throw defect.error;
      return (
        ids
          .map((id) => entries.get(id)?.error)
          .find((error) => error != null) ?? null
      );
    },
    retrying: (ids: readonly string[]) => ids.some((id) => {
      const entry = entries.get(id);
      return entry !== undefined && entry.error !== null && (entry.stale || entry.resolving);
    }),
    retry: invalidate,
    retryFailed: () =>
      invalidate([...entries.keys()].filter((id) => entries.get(id)!.error)),
    /** Consumption moved: reread; lists re-query only if an ordering fact moved. */
    invalidateAll: () => invalidate(entries.keys()),
    /** The page returned or bibliography changed: lists re-query too. */
    invalidateQueries: () => invalidateQueries(entries.keys()),
  };
}

type Store = ReturnType<typeof createStore>;
const Context = createContext<Store | null>(null);

function useStore(): Store {
  const store = useContext(Context);
  if (store === null)
    throw new Error("Media summaries require their account provider");
  return store;
}

/** Runs `effect` when `key` moves after the first render. */
function useOnChange(key: string, effect: () => void) {
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    effect();
  });
}

export function MediaSummaryProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createStore);
  useLayoutEffect(() => store.attach(), [store]);
  const foreground = useRefreshStamp(true, 60_000);
  useEffect(() => {
    window.addEventListener("online", store.retryFailed);
    return () => window.removeEventListener("online", store.retryFailed);
  }, [store]);
  useOnChange(useChangeStamp("Consumption"), store.invalidateAll);
  useOnChange(
    `${useChangeStamp("Metadata")}:${foreground}`,
    store.invalidateQueries,
  );
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useMediaSummaries(seeds: readonly MediaSummary[]) {
  const store = useStore();
  const revision = useSyncExternalStore(
    store.subscribe,
    store.revision,
    () => 0,
  );
  const key = [...new Set(seeds.map((seed) => seed.media_id))].sort().join(",");
  const seedsRef = useRef(seeds);
  seedsRef.current = seeds;
  useEffect(() => store.retain(seedsRef.current), [store, key]);
  return useMemo(() => {
    const ids = key === "" ? [] : key.split(",");
    return {
      resolve: store.resolve,
      error: store.error(ids),
      retry: () => store.retry(ids),
      retrying: store.retrying(ids),
      revision,
      queryRevision: store.queryRevision(),
    };
  }, [store, revision, key]);
}

export function useMediaQueryRevision(): number {
  const store = useStore();
  useSyncExternalStore(store.subscribe, store.revision, () => 0);
  return store.queryRevision();
}
