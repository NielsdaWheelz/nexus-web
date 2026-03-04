"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ReaderState } from "./types";

type ApiFetchFn = typeof apiFetch;

interface UseReaderStateOptions {
  mediaId: string | null;
  apiFetch?: ApiFetchFn;
  debounceMs?: number;
}

export function useReaderState(options: UseReaderStateOptions) {
  const { mediaId, apiFetch: fetchFn = apiFetch, debounceMs = 500 } = options;
  const [state, setState] = useState<ReaderState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<ReaderState> | null>(null);

  const load = useCallback(async () => {
    if (!mediaId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFn<{ data: ReaderState }>(
        `/api/media/${mediaId}/reader-state`
      );
      setState(res.data);
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        setState(null);
      } else {
        setError(
          isApiError(err) ? err.message : "Failed to load reader state"
        );
      }
    } finally {
      setLoading(false);
    }
  }, [mediaId, fetchFn]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    (updates: Partial<ReaderState>) => {
      if (!mediaId) return;

      pendingRef.current = { ...pendingRef.current, ...updates };

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(async () => {
        const payload = pendingRef.current;
        pendingRef.current = null;
        debounceRef.current = null;
        if (!payload) return;

        try {
          const res = await fetchFn<{ data: ReaderState }>(
            `/api/media/${mediaId}/reader-state`,
            {
              method: "PATCH",
              body: JSON.stringify(payload),
            }
          );
          setState(res.data);
        } catch (err) {
          console.error("Failed to save reader state:", err);
        }
      }, debounceMs);
    },
    [mediaId, fetchFn, debounceMs]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  return { state, loading, error, load, save };
}
