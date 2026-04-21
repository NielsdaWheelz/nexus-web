"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  parseReaderResumeState,
  readerResumeStatesEqual,
  type ReaderResumeState,
} from "./types";

type ApiFetchFn = typeof apiFetch;

interface UseReaderResumeStateOptions {
  mediaId: string | null;
  apiFetch?: ApiFetchFn;
  debounceMs?: number;
}

export function useReaderResumeState(options: UseReaderResumeStateOptions) {
  const { mediaId, apiFetch: fetchFn = apiFetch, debounceMs = 500 } = options;
  const [state, setState] = useState<ReaderResumeState | null>(null);
  const [loading, setLoading] = useState(Boolean(mediaId));
  const [error, setError] = useState<string | null>(null);
  const [resolvedMediaId, setResolvedMediaId] = useState<string | null>(null);
  const stateRef = useRef<ReaderResumeState | null>(null);
  const pendingRef = useRef<ReaderResumeState | null>(null);
  const hasPendingRef = useRef(false);
  const hydratedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const flush = useCallback(async () => {
    if (!mediaId || !hydratedRef.current || !hasPendingRef.current) {
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const payload = pendingRef.current;
    hasPendingRef.current = false;

    try {
      const res = await fetchFn<{ data: unknown }>(`/api/media/${mediaId}/reader-state`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const savedState = parseReaderResumeState(res.data);
      stateRef.current = savedState;
      setState(savedState);
    } catch (err) {
      console.error("Failed to save reader state:", err);
      pendingRef.current = payload;
      hasPendingRef.current = true;
    }
  }, [mediaId, fetchFn]);

  const load = useCallback(async () => {
    if (!mediaId) {
      hydratedRef.current = false;
      hasPendingRef.current = false;
      pendingRef.current = null;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      stateRef.current = null;
      setState(null);
      setResolvedMediaId(null);
      setLoading(false);
      setError(null);
      return;
    }

    const targetMediaId = mediaId;
    hydratedRef.current = false;
    hasPendingRef.current = false;
    pendingRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    stateRef.current = null;
    setState(null);
    setResolvedMediaId(null);
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFn<{ data: unknown }>(`/api/media/${targetMediaId}/reader-state`);
      const nextState = parseReaderResumeState(res.data);
      stateRef.current = nextState;
      setState(nextState);
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        stateRef.current = null;
        setState(null);
      } else {
        setError(isApiError(err) ? err.message : "Failed to load reader state");
      }
    } finally {
      hydratedRef.current = true;
      setResolvedMediaId(targetMediaId);
      setLoading(false);
    }
  }, [mediaId, fetchFn]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (nextState: ReaderResumeState | null) => {
      if (!mediaId || !hydratedRef.current) {
        return;
      }

      const normalizedNextState = parseReaderResumeState(nextState);
      const baseline = hasPendingRef.current ? pendingRef.current : stateRef.current;
      if (readerResumeStatesEqual(baseline, normalizedNextState)) {
        return;
      }

      pendingRef.current = normalizedNextState;
      hasPendingRef.current = true;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        void flush();
      }, debounceMs);
    },
    [debounceMs, flush, mediaId]
  );

  useEffect(() => {
    const flushOnPageHide = () => {
      void flush();
    };
    const flushOnVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flush();
      }
    };

    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushOnVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushOnVisibilityChange);
      void flush();
    };
  }, [flush]);

  const activeLoading = Boolean(mediaId) && resolvedMediaId !== mediaId ? true : loading;
  const activeState = resolvedMediaId === mediaId ? state : null;

  return { state: activeState, loading: activeLoading, error, load, save };
}
