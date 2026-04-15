"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ReaderResumeState } from "./types";

type ApiFetchFn = typeof apiFetch;

interface UseReaderResumeStateOptions {
  mediaId: string | null;
  apiFetch?: ApiFetchFn;
  debounceMs?: number;
}

export function useReaderResumeState(options: UseReaderResumeStateOptions) {
  const { mediaId, apiFetch: fetchFn = apiFetch, debounceMs = 500 } = options;
  const [state, setState] = useState<ReaderResumeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<ReaderResumeState | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<ReaderResumeState> | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const load = useCallback(async () => {
    if (!mediaId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFn<{ data: ReaderResumeState }>(
        `/api/media/${mediaId}/reader-state`
      );
      stateRef.current = res.data;
      setState(res.data);
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        stateRef.current = null;
        setState(null);
      } else {
        setError(
          isApiError(err) ? err.message : "Failed to load reader resume state"
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
    (updates: Partial<ReaderResumeState>) => {
      if (!mediaId) return;

      const nextPending = { ...pendingRef.current, ...updates };
      const baseline = pendingRef.current ?? stateRef.current;
      let changed = baseline === null;

      for (const key of Object.keys(nextPending) as Array<keyof ReaderResumeState>) {
        if (baseline?.[key] !== nextPending[key]) {
          changed = true;
          break;
        }
      }

      if (!changed) {
        return;
      }

      pendingRef.current = nextPending;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(async () => {
        const payload = pendingRef.current;
        pendingRef.current = null;
        debounceRef.current = null;
        if (!payload) return;

        try {
          const res = await fetchFn<{ data: ReaderResumeState }>(
            `/api/media/${mediaId}/reader-state`,
            {
              method: "PATCH",
              body: JSON.stringify(payload),
            }
          );
          stateRef.current = res.data;
          setState(res.data);
        } catch (err) {
          console.error("Failed to save reader resume state:", err);
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
