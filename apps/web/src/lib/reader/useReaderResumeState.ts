"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ReaderLocator } from "./types";

type ApiFetchFn = typeof apiFetch;

interface UseReaderResumeStateOptions {
  mediaId: string | null;
  apiFetch?: ApiFetchFn;
  debounceMs?: number;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeReaderLocator(value: unknown): ReaderLocator | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const locator: ReaderLocator = {
    source: normalizeString(record.source),
    anchor: normalizeString(record.anchor),
    text_offset: normalizeNumber(record.text_offset),
    quote: normalizeString(record.quote),
    quote_prefix: normalizeString(record.quote_prefix),
    quote_suffix: normalizeString(record.quote_suffix),
    progression: normalizeNumber(record.progression),
    total_progression: normalizeNumber(record.total_progression),
    position: normalizeNumber(record.position),
    page: normalizeNumber(record.page),
    page_progression: normalizeNumber(record.page_progression),
    zoom: normalizeNumber(record.zoom),
  };

  return Object.values(locator).some((entry) => entry !== null) ? locator : null;
}

function readerLocatorsEqual(
  left: ReaderLocator | null,
  right: ReaderLocator | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.source === right.source &&
    left.anchor === right.anchor &&
    left.text_offset === right.text_offset &&
    left.quote === right.quote &&
    left.quote_prefix === right.quote_prefix &&
    left.quote_suffix === right.quote_suffix &&
    left.progression === right.progression &&
    left.total_progression === right.total_progression &&
    left.position === right.position &&
    left.page === right.page &&
    left.page_progression === right.page_progression &&
    left.zoom === right.zoom
  );
}

export function useReaderResumeState(options: UseReaderResumeStateOptions) {
  const { mediaId, apiFetch: fetchFn = apiFetch, debounceMs = 500 } = options;
  const [state, setState] = useState<ReaderLocator | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<ReaderLocator | null>(null);
  const pendingRef = useRef<ReaderLocator | null>(null);
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
      const savedState = normalizeReaderLocator(res.data);
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
      setLoading(false);
      setError(null);
      return;
    }

    hydratedRef.current = false;
    hasPendingRef.current = false;
    pendingRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFn<{ data: unknown }>(`/api/media/${mediaId}/reader-state`);
      const nextState = normalizeReaderLocator(res.data);
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
      setLoading(false);
    }
  }, [mediaId, fetchFn]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (nextState: ReaderLocator | null) => {
      if (!mediaId || !hydratedRef.current) {
        return;
      }

      const normalizedNextState = normalizeReaderLocator(nextState);
      const baseline = hasPendingRef.current ? pendingRef.current : stateRef.current;
      if (readerLocatorsEqual(baseline, normalizedNextState)) {
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

  return { state, loading, error, load, save };
}
