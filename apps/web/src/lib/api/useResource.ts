"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiError,
  type ApiPath,
} from "@/lib/api/client";
import { ResourceCacheContext, type ResourceCacheEntry } from "@/lib/api/resourceCache";
import type { ResourceDescriptor } from "@/lib/api/resource";
import { requestWithRetry } from "@/lib/api/retryPolicy";
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
  // Defects belong to the applicable render boundary, not to AsyncResource's
  // modeled request state. Keep the failing key so a later resource identity
  // can render its own loading state before its effect starts.
  const [defect, setDefect] = useState<{ key: string; error: unknown } | null>(
    null,
  );

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

  const [resourceState, setResourceState] = useState<{
    key: string | null;
    resource: AsyncResource<T>;
  }>(() => {
    if (seeded !== null && seeded.entry.status === "ready") {
      return {
        key: cacheKey,
        resource: { status: "ready", data: seeded.entry.data as T },
      };
    }
    return {
      key: cacheKey,
      resource:
        cacheKey === null ? { status: "idle" } : { status: "loading" },
    };
  });
  const resource: AsyncResource<T> =
    resourceState.key === cacheKey
      ? resourceState.resource
      : cacheKey === null
        ? { status: "idle" }
        : { status: "loading" };

  useEffect(() => {
    if (claimSeed && seeded !== null && cache !== null) {
      cache.consume(seeded.key);
    }
  }, [cache, seeded, claimSeed]);

  useEffect(() => {
    if (cacheKey === null) {
      setResourceState({ key: null, resource: { status: "idle" } });
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
            if (!cancelled) {
              setResourceState({
                key: cacheKey,
                resource: { status: "ready", data: data as T },
              });
            }
          },
          (error) => {
            if (cancelled || isAbortError(error)) return;
            if (handleUnauthenticatedApiError(error)) return;
            if (!isApiError(error) || isSameSystemApiDefect(error)) {
              setDefect({ key: cacheKey, error });
              return;
            }
            retry();
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
    setResourceState({
      key: cacheKey,
      resource: { status: "loading" },
    });

    const run = async () => {
      try {
        const data = await requestWithRetry(
          (signal) => loadRef.current(signal),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResourceState({
          key: cacheKey,
          resource: { status: "ready", data },
        });
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return;
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          setDefect({ key: cacheKey, error: err });
          return;
        }
        setResourceState({
          key: cacheKey,
          resource: { status: "error", error: err, retry },
        });
      }
    };
    run();

    return () => {
      controller.abort();
    };
  }, [cacheKey, retryTick, retry, handleUnauthenticatedApiError]);

  if (defect?.key === cacheKey) {
    throw defect.error;
  }

  return resource;
}
