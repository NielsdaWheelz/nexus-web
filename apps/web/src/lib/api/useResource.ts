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

type DescriptorResourceArgs<T, P> = {
  descriptor: ResourceDescriptor<P>;
  params: P | null;
  load?: (params: P, signal: AbortSignal) => Promise<T>;
};

type PathResourceArgs = {
  cacheKey: string | null;
  path: (cacheKey: string) => ApiPath;
};

type LoadResourceArgs<T> = {
  cacheKey: string | null;
  load: (signal: AbortSignal) => Promise<T>;
};

// The one async-resource hook: a keyed GET-or-custom-load with 3× retry/backoff
// and abort. When the server seeded the initial cacheKey into the resource cache,
// it consumes that value once and skips the first fetch.
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
  // Peek the seeded entry for the initial cacheKey (read-only — safe in render): it
  // paints synchronously and skips the first fetch. consume() runs post-commit.
  const seededRef = useRef<{ key: string; entry: ResourceCacheEntry } | null>(null);
  if (seededRef.current === null && cacheKey !== null && cache !== null) {
    const entry = cache.peek(cacheKey);
    if (entry !== null) {
      seededRef.current = { key: cacheKey, entry };
    }
  }
  const seeded = seededRef.current;

  const skipKeyRef = useRef(seeded !== null ? seeded.key : null);

  const [resourceState, setResourceState] = useState<{
    key: string | null;
    resource: AsyncResource<T>;
  }>(() => {
    if (seeded !== null) {
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
    if (seeded !== null && cache !== null) {
      cache.consume(seeded.key);
    }
  }, [cache, seeded]);

  useEffect(() => {
    // A defect recorded for a superseded key is stale once another key begins
    // loading. Clear it so returning to a previously-defected key re-fetches
    // instead of re-throwing the old defect during render.
    setDefect((current) => (current && current.key !== cacheKey ? null : current));
    if (cacheKey === null) {
      setResourceState({ key: null, resource: { status: "idle" } });
      return;
    }
    if (skipKeyRef.current === cacheKey) {
      skipKeyRef.current = null;
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
