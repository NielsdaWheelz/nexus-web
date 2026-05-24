"use client";

import { useEffect, useRef, useState } from "react";

export interface LazyFetchOnOpenState<T> {
  data: T | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

/**
 * Lazy-load a resource the first time a disclosure opens; keep the result
 * cached for subsequent open/close toggles; reset and re-fetch when
 * `cacheKey` changes (e.g. when the underlying entity id flips).
 *
 * `load` is read through a ref so callers don't have to memoize it.
 *
 * The original pattern (one useState quartet + a reset effect + a fetch
 * effect + manual `let cancelled = false`) lived inline in each disclosure
 * component; this hook owns it.
 */
export function useLazyFetchOnOpen<T>(args: {
  open: boolean;
  /** Inputs to identify the resource; a change resets and re-fetches. */
  cacheKey: string;
  load: () => Promise<T>;
  /** Stored on `state.error` when `load()` rejects. */
  errorMessage: string;
}): LazyFetchOnOpenState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadedRef = useRef(false);
  const loadRef = useRef(args.load);
  loadRef.current = args.load;

  useEffect(() => {
    loadedRef.current = false;
    setData(null);
    setLoaded(false);
    setError(null);
  }, [args.cacheKey]);

  useEffect(() => {
    if (!args.open || loadedRef.current) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoaded(true);
        loadedRef.current = true;
      })
      .catch(() => {
        if (!cancelled) setError(args.errorMessage);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [args.cacheKey, args.errorMessage, args.open]);

  return { data, loading, loaded, error };
}
