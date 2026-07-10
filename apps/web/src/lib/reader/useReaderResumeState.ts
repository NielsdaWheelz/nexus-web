"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { toFeedback } from "@/components/feedback/Feedback";
import type { AttentionTracker } from "./useAttentionTracker";
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
  attention?: AttentionTracker;
}

function progressionOf(locator: ReaderResumeState | null): number | null {
  if (!locator) return null;
  if (locator.kind === "pdf") return locator.page_progression ?? null;
  return locator.locations.total_progression ?? null;
}

export function useReaderResumeState(options: UseReaderResumeStateOptions) {
  const { mediaId, apiFetch: fetchFn = apiFetch, debounceMs = 500, attention } = options;
  const [state, setState] = useState<ReaderResumeState | null>(null);
  const [loading, setLoading] = useState(Boolean(mediaId));
  const [error, setError] = useState<string | null>(null);
  const [resolvedMediaId, setResolvedMediaId] = useState<string | null>(null);
  const stateRef = useRef<ReaderResumeState | null>(null);
  const pendingRef = useRef<ReaderResumeState | null>(null);
  const pendingMediaIdRef = useRef<string | null>(null);
  const hasPendingRef = useRef(false);
  const hydratedRef = useRef(false);
  const hydratedMediaIdRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRequestRef = useRef(0);
  const attentionRef = useRef<AttentionTracker | undefined>(attention);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    attentionRef.current = attention;
  }, [attention]);

  const flush = useCallback(
    async (keepalive = false) => {
      const targetMediaId = mediaId;
      if (
        !targetMediaId ||
        !hydratedRef.current ||
        hydratedMediaIdRef.current !== targetMediaId
      ) {
        return;
      }

      const hasPendingLocator =
        hasPendingRef.current && pendingMediaIdRef.current === targetMediaId;
      const tracker = attentionRef.current;
      // Dwell accrues from rAF timestamp deltas (fractional ms), but the ledger
      // wire contract is an integer (attention.dwell_ms_delta: int). A fractional
      // value fails backend validation and 400s the whole envelope — taking the
      // piggybacked locator write down with it — so round at the boundary.
      const dwell = tracker ? Math.round(tracker.dwellDeltaRef.current) : 0;
      if (!hasPendingLocator && dwell === 0) {
        return;
      }

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      const locatorPayload = hasPendingLocator ? pendingRef.current : stateRef.current;
      hasPendingRef.current = false;

      // A clear (explicit null locator) stays a bare null body; attention is
      // ignored on a clear (the reader is closing).
      let body: unknown;
      let sentDwell = 0;
      if (locatorPayload === null && hasPendingLocator) {
        body = null;
      } else if (tracker) {
        tracker.resetDelta();
        sentDwell = dwell;
        body = {
          locator: locatorPayload,
          attention: {
            dwell_ms_delta: dwell,
            device_id: tracker.deviceId,
            spans_touched: [],
            progression: progressionOf(locatorPayload),
          },
        };
      } else {
        body = locatorPayload;
      }

      try {
        const res = await fetchFn<{ data: unknown }>(
          `/api/media/${targetMediaId}/reader-state`,
          { method: "PUT", body: JSON.stringify(body), ...(keepalive ? { keepalive } : {}) },
        );
        const savedState = parseReaderResumeState(res.data);
        if (!hydratedRef.current || hydratedMediaIdRef.current !== targetMediaId) {
          return;
        }
        stateRef.current = savedState;
        setState(savedState);
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        console.error("Failed to save reader state:", err);
        // Best-effort dwell: the delta was zeroed before the request, so add it
        // back (the rAF loop may have accrued more since) to retry next flush —
        // otherwise dwell accrued during a failed save is silently dropped.
        if (sentDwell > 0 && tracker) {
          tracker.dwellDeltaRef.current += sentDwell;
        }
        if (hasPendingLocator && hydratedRef.current && hydratedMediaIdRef.current === targetMediaId) {
          pendingRef.current = locatorPayload;
          pendingMediaIdRef.current = targetMediaId;
          hasPendingRef.current = true;
        }
      }
    },
    [fetchFn, mediaId],
  );

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (!mediaId) {
      hydratedRef.current = false;
      hydratedMediaIdRef.current = null;
      hasPendingRef.current = false;
      pendingRef.current = null;
      pendingMediaIdRef.current = null;
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
    hydratedMediaIdRef.current = null;
    hasPendingRef.current = false;
    pendingRef.current = null;
    pendingMediaIdRef.current = null;
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
      if (loadRequestRef.current !== requestId) {
        return;
      }
      const nextState = parseReaderResumeState(res.data);
      stateRef.current = nextState;
      setState(nextState);
    } catch (err) {
      if (loadRequestRef.current !== requestId) {
        return;
      }
      if (isApiError(err) && err.status === 404) {
        stateRef.current = null;
        setState(null);
      } else if (handleUnauthenticatedApiError(err)) {
        return;
      } else {
        setError(toFeedback(err, { fallback: "Failed to load reader state" }).title);
      }
    } finally {
      if (loadRequestRef.current !== requestId) {
        return;
      }
      hydratedRef.current = true;
      hydratedMediaIdRef.current = targetMediaId;
      setResolvedMediaId(targetMediaId);
      setLoading(false);
    }
  }, [mediaId, fetchFn]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (nextState: ReaderResumeState | null) => {
      if (!mediaId || !hydratedRef.current || hydratedMediaIdRef.current !== mediaId) {
        return;
      }

      const baseline = hasPendingRef.current ? pendingRef.current : stateRef.current;
      if (readerResumeStatesEqual(baseline, nextState)) {
        return;
      }

      pendingRef.current = nextState;
      pendingMediaIdRef.current = mediaId;
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
      void flush(true);
    };
    const flushOnVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flush(true);
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
