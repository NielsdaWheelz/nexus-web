"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, isApiError, type ApiPath } from "@/lib/api/client";
import { HydrationCacheContext } from "@/lib/api/hydrationCache";
import type { ResourceDescriptor } from "@/lib/api/resource";
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

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;

// The one async-resource hook: a keyed GET-or-custom-load with 3× retry/backoff
// and abort. When the server prefetched the initial cacheKey into the hydration
// cache, it claims that value (consume-once) and skips the first fetch.
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

  // Seed "ready" and skip the first fetch for the initial cacheKey when the
  // server prefetched it into the hydration cache (consume-once).
  const cache = useContext(HydrationCacheContext);
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();
  const seededRef = useRef<{ key: string; data: T } | null>(null);
  if (seededRef.current === null && cacheKey !== null) {
    if (cache !== null && cache.has(cacheKey)) {
      seededRef.current = { key: cacheKey, data: cache.get(cacheKey) as T };
      cache.delete(cacheKey);
    }
  }
  const seeded = seededRef.current;

  const skipKeyRef = useRef(seeded !== null ? seeded.key : null);

  const [resource, setResource] = useState<AsyncResource<T>>(() => {
    if (seeded !== null) {
      return { status: "ready", data: seeded.data };
    }
    return cacheKey === null ? { status: "idle" } : { status: "loading" };
  });

  useEffect(() => {
    if (cacheKey === null) {
      setResource({ status: "idle" });
      return;
    }
    if (skipKeyRef.current === cacheKey) {
      skipKeyRef.current = null;
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
