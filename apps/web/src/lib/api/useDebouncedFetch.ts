"use client";

import { useEffect, useRef, useState } from "react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";

export interface DebouncedFetch<T> {
  data: T | null;
  loading: boolean;
  error: unknown | null;
}

// One debounced single-shot fetch keyed by `key`. A `key` change sets loading,
// waits `debounceMs`, then runs the latest `fetcher` with a fresh AbortController;
// a `null` key disables the fetch (clears data/error, not loading) and aborts any
// in-flight call. Aborted resolutions and unauthenticated errors are swallowed.
// Pagination/append flows do not belong here — keep those in the caller.
export function useDebouncedFetch<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: { debounceMs?: number },
): DebouncedFetch<T> {
  const debounceMs = options?.debounceMs ?? 200;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [state, setState] = useState<DebouncedFetch<T>>({
    data: null,
    loading: key !== null,
    error: null,
  });

  useEffect(() => {
    if (key === null) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const timer = window.setTimeout(() => {
      void fetcherRef
        .current(controller.signal)
        .then((data) => {
          if (!cancelled) setState({ data, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (cancelled || isAbortError(error)) return;
          if (handleUnauthenticatedApiError(error)) return;
          setState({ data: null, loading: false, error });
        });
    }, debounceMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, debounceMs]);

  return state;
}
