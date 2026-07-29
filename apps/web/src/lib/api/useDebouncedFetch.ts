"use client";

import { useEffect, useRef, useState } from "react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";

export interface DebouncedFetch<T> {
  data: T | null;
  dataIdentity: string | null;
  loading: boolean;
  error: unknown | null;
  errorIdentity: string | null;
}

// One debounced single-shot fetch keyed by `key`. `identity` names the logical
// request independently of a retry nonce. Data and errors carry the identity
// that produced them so callers cannot project an old revision; a failed retry
// retains the last committed data. A null key clears state and aborts in-flight
// work. Aborts and unauthenticated errors are swallowed. Pagination/append
// flows do not belong here.
export function useDebouncedFetch<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: { debounceMs?: number; identity?: string | null },
): DebouncedFetch<T> {
  const debounceMs = options?.debounceMs ?? 200;
  const identity = options?.identity ?? key;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [state, setState] = useState<DebouncedFetch<T>>({
    data: null,
    dataIdentity: null,
    loading: key !== null,
    error: null,
    errorIdentity: null,
  });

  useEffect(() => {
    if (key === null) {
      setState({
        data: null,
        dataIdentity: null,
        loading: false,
        error: null,
        errorIdentity: null,
      });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState((prev) => ({
      ...prev,
      loading: true,
      error: null,
      errorIdentity: null,
    }));
    const timer = window.setTimeout(() => {
      void fetcherRef
        .current(controller.signal)
        .then((data) => {
          if (!cancelled) {
            setState({
              data,
              dataIdentity: identity,
              loading: false,
              error: null,
              errorIdentity: null,
            });
          }
        })
        .catch((error: unknown) => {
          if (cancelled || isAbortError(error)) return;
          if (handleUnauthenticatedApiError(error)) return;
          setState((previous) => ({
            ...previous,
            loading: false,
            error,
            errorIdentity: identity,
          }));
        });
    }, debounceMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, debounceMs, identity]);

  return state;
}
