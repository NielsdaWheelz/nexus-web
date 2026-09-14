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
type SeedClaimArgs = {
  claimSeed?: boolean;
  /** A retained coordinator may forward defects to its descendant boundary. */
  onDefect?: (error: unknown) => void;
};

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
  const defectObserver = useRef(args.onDefect);
  defectObserver.current = args.onDefect;
  useEffect(() => {
    if (defect?.key === cacheKey) defectObserver.current?.(defect.error);
  }, [cacheKey, defect]);

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
    if (seeded !== null && cache !== null && (claimSeed || seeded.entry.status === "pending")) {
      // Even an ambient reader owns an adopted running request. claimSeed:false
      // preserves ready hydration seeds; it cannot make foreground reads abortable
      // by a hover surface that has moved away.
      cache.consume(seeded.key, seeded.entry);
    }
  }, [cache, seeded, claimSeed]);

  useEffect(() => {
    // A defect recorded for a superseded key is stale once another key begins
    // loading. Clear it so returning to a previously-defected key re-fetches
    // instead of re-throwing the old defect during render.
    setDefect((current) => (current && current.key !== cacheKey ? null : current));
    if (cacheKey === null) {
      setResourceState({ key: null, resource: { status: "idle" } });
      return;
    }
    let adopted: Promise<unknown> | null = null;
    if (skipKeyRef.current === cacheKey) {
      skipKeyRef.current = null;
      const seededEntry = seededRef.current;
      if (seededEntry !== null && seededEntry.entry.status === "pending") {
        // Cache owns this request's cancellation. Adoption consumes its first
        // attempt, then this consumer owns only the remaining retry budget.
        if (!seededEntry.entry.signal.aborted) adopted = seededEntry.entry.promise;
      } else {
        // A ready seed was applied synchronously during initial render.
        return;
      }
    }

    const controller = new AbortController();
    setResourceState({
      key: cacheKey,
      resource: { status: "loading" },
    });

    const run = async () => {
      try {
        const data = await requestWithRetry(
          (signal, attempt) => attempt === 1 && adopted !== null
            ? adopted as Promise<T> : loadRef.current(signal),
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

  if (defect?.key === cacheKey && !args.onDefect) {
    throw defect.error;
  }

  return resource;
}
