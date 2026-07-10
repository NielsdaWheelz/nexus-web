"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, isApiError, type ApiPath } from "@/lib/api/client";
import { ResourceCacheContext, type ResourceCacheEntry } from "@/lib/api/resourceCache";
import type { ResourceDescriptor } from "@/lib/api/resource";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";

export type AsyncResource<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ApiError; retry: () => void };

// claimSeed (default true) controls whether this consumer, on reading a seeded/
// prefetched entry, also *consumes* it (removes it so a later re-open fetches fresh).
// A seed is one-shot, but a single key can have several first-paint consumers (e.g. the
// pane it was seeded for plus an always-mounted chrome reader). Only the owner should
// claim; ambient readers pass claimSeed:false so they paint from the seed without
// starving the owner's first render — otherwise whichever commits first (the eager
// chrome reader) removes the seed before the lazy owner pane hydrates, so the pane
// renders its loading state against server-rendered content and hydration mismatches.
type SeedClaimArgs = { claimSeed?: boolean };

type DescriptorResourceArgs<T, P> = SeedClaimArgs & {
  descriptor: ResourceDescriptor<P>;
  params: P | null;
  load?: (params: P, signal: AbortSignal) => Promise<T>;
};

type PathResourceArgs = SeedClaimArgs & {
  cacheKey: string | null;
  path: (cacheKey: string) => ApiPath;
};

type LoadResourceArgs<T> = SeedClaimArgs & {
  cacheKey: string | null;
  load: (signal: AbortSignal) => Promise<T>;
};

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;

// The one async-resource hook: a keyed GET-or-custom-load with 3× retry/backoff
// and abort. When the server seed or a client prefetch put the initial cacheKey
// into the resource cache, it consumes that value once and skips the first fetch.
export function useResource<T, P>(
  args: DescriptorResourceArgs<T, P>,
): AsyncResource<T>;
export function useResource<T>(args: PathResourceArgs): AsyncResource<T>;
export function useResource<T>(args: LoadResourceArgs<T>): AsyncResource<T>;
export function useResource<T, P>(
  args: DescriptorResourceArgs<T, P> | PathResourceArgs | LoadResourceArgs<T>,
): AsyncResource<T> {
  const cacheKey =
    "descriptor" in args
      ? args.params === null
        ? null
        : args.descriptor.cacheKey(args.params)
      : args.cacheKey;
  const load: (signal: AbortSignal) => Promise<T> = "descriptor" in args
    ? (signal) => {
        if (args.params === null) {
          throw new Error("Cannot load a resource with null params.");
        }
        if (args.load) {
          return args.load(args.params, signal);
        }
        return apiFetch<T>(args.descriptor.clientPath(args.params), { signal });
      }
    : "load" in args
      ? args.load
      : (signal) => apiFetch<T>(args.path(cacheKey as string), { signal });
  const loadRef = useRef(load);
  loadRef.current = load;

  const [retryTick, setRetryTick] = useState(0);
  const retry = useCallback(() => setRetryTick((n) => n + 1), []);

  const cache = useContext(ResourceCacheContext);
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();
  // Peek the seeded/prefetched entry for the initial cacheKey (read-only — safe in
  // render). A ready entry (server seed or settled prefetch) paints synchronously and
  // skips the first fetch; a pending entry (prefetch still in flight) is awaited in the
  // load effect instead of starting a second fetch. consume() runs post-commit.
  const seededRef = useRef<{ key: string; entry: ResourceCacheEntry } | null>(null);
  if (seededRef.current === null && cacheKey !== null && cache !== null) {
    const entry = cache.peek(cacheKey);
    if (entry !== null) {
      seededRef.current = { key: cacheKey, entry };
    }
  }
  const seeded = seededRef.current;
  const claimSeed = args.claimSeed ?? true;

  const skipKeyRef = useRef(seeded !== null ? seeded.key : null);

  const [resource, setResource] = useState<AsyncResource<T>>(() => {
    if (seeded !== null && seeded.entry.status === "ready") {
      return { status: "ready", data: seeded.entry.data as T };
    }
    return cacheKey === null ? { status: "idle" } : { status: "loading" };
  });

  useEffect(() => {
    if (claimSeed && seeded !== null && cache !== null) {
      cache.consume(seeded.key);
    }
  }, [cache, seeded, claimSeed]);

  useEffect(() => {
    if (cacheKey === null) {
      setResource({ status: "idle" });
      return;
    }
    if (skipKeyRef.current === cacheKey) {
      skipKeyRef.current = null;
      // A pending prefetch is in flight for this key: adopt its promise (no second
      // fetch). On success → ready; on failure → re-run this effect to fetch fresh.
      const seededEntry = seededRef.current;
      if (seededEntry !== null && seededEntry.entry.status === "pending") {
        // Adopt the in-flight prefetch's promise; do NOT abort its (cache-owned, possibly
        // shared) controller on unmount — just ignore a late result. The cache's LRU owns
        // cancellation; a background completion is harmless (the entry is already consumed).
        const { promise } = seededEntry.entry;
        let cancelled = false;
        promise.then(
          (data) => {
            if (!cancelled) setResource({ status: "ready", data: data as T });
          },
          () => {
            if (!cancelled) retry();
          },
        );
        return () => {
          cancelled = true;
        };
      }
      // A ready seed was already applied synchronously in the useState initializer.
      return;
    }

    const controller = new AbortController();
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 1;
    setResource({ status: "loading" });

    const run = async () => {
      try {
        const data = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setResource({ status: "ready", data });
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return;
        if (handleUnauthenticatedApiError(err)) return;
        const retryable = !isApiError(err) || err.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          attempt += 1;
          const delay = Math.min(
            BASE_DELAY_MS * 2 ** (attempt - 2),
            MAX_DELAY_MS,
          );
          const jittered = delay * (0.75 + Math.random() * 0.5);
          delayTimer = setTimeout(run, jittered);
          return;
        }
        const apiError = isApiError(err)
          ? err
          : new ApiError(
              0,
              "E_NETWORK",
              err instanceof Error ? err.message : "Request failed",
            );
        setResource({ status: "error", error: apiError, retry });
      }
    };
    run();

    return () => {
      controller.abort();
      if (delayTimer !== null) clearTimeout(delayTimer);
    };
  }, [cacheKey, retryTick, retry, handleUnauthenticatedApiError]);

  return resource;
}
