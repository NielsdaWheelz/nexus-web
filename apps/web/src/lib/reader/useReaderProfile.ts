"use client";

/**
 * The one browser owner of reader-profile writes and revalidation.
 *
 * One logical PATCH is in flight per provider with one latest-merged queue;
 * discrete fields send immediately when idle, range fields after 400 ms idle
 * within a 5 s maximum. Revalidation is event-driven only (visible, focus,
 * pageshow, online) and adopts only from Clean with an unchanged intent
 * generation. Decisions are pure in `readerProfileSync.ts`; this hook owns
 * timers, fetches, the attempt watchdog, lifecycle flush, and listeners.
 *
 * Defective settlements (contract errors) throw out of the continuation; the
 * 35 s attempt watchdog is the liveness escape that converts the wedged
 * attempt into a retryable failure.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  classifyReaderProfileSaveError,
  desiredReaderProfile,
  initialReaderProfileSyncState,
  parseReaderProfile,
  readerProfilePersistence,
  readerProfileWorkDueAt,
  readerProfilesEqual,
  reduceReaderProfileSync,
  sendableReaderProfilePatch,
  type ReaderProfilePatch,
  type ReaderProfilePersistence,
  type ReaderProfileSyncEvent,
  type ReaderProfileSyncState,
} from "./readerProfileSync";
import type { ReaderProfile } from "./types";

export interface UseReaderProfileResult {
  /** Optimistic desired projection; drives pixels. */
  profile: ReaderProfile;
  persistence: ReaderProfilePersistence;
  /** Semantic-setter seam for the provider; not a public save. */
  intend: (patch: ReaderProfilePatch) => void;
  retrySave: () => void;
}

export function useReaderProfile(initialProfile: ReaderProfile): UseReaderProfileResult {
  const [state, dispatch] = useReducer(
    reduceReaderProfileSync,
    initialProfile,
    initialReaderProfileSyncState,
  );
  const stateRef = useRef<ReaderProfileSyncState>(state);
  stateRef.current = state;

  const attemptSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const intentGenerationRef = useRef(0);
  const revalidateInFlightRef = useRef(false);

  /** Reduce, mirror synchronously, and dispatch — callers act on the result. */
  const apply = useCallback((event: ReaderProfileSyncEvent): ReaderProfileSyncState => {
    const next = reduceReaderProfileSync(stateRef.current, event);
    stateRef.current = next;
    dispatch(event);
    return next;
  }, []);

  const send = useCallback(async (): Promise<void> => {
    const patch = sendableReaderProfilePatch(stateRef.current.local);
    if (patch === null) {
      return;
    }
    attemptSeqRef.current += 1;
    const attemptId = attemptSeqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    apply({ type: "save_started", attemptId, now: Date.now() });
    try {
      const res = await apiFetch<{ data: unknown }>("/api/me/reader-profile", {
        method: "PATCH",
        body: JSON.stringify(patch),
        keepalive: true,
        signal: controller.signal,
      });
      apply({ type: "save_succeeded", attemptId, profile: parseReaderProfile(res.data) });
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) {
        return;
      }
      const local = stateRef.current.local;
      if (local.status !== "saving" || local.attemptId !== attemptId) {
        // The watchdog already expired this attempt (including our own abort);
        // late settlement is ignored.
        return;
      }
      apply({ type: "save_failed", attemptId, failure: classifyReaderProfileSaveError(err) });
    }
  }, [apply]);

  // Deferred-work scheduling: Immediate work sends now; range work at
  // min(idleAt, deadlineAt). Re-arms on every transition, so work queued
  // behind an acknowledged PATCH resumes its remaining clock.
  useEffect(() => {
    if (state.local.status !== "deferred") {
      return;
    }
    const delay = Math.max(0, readerProfileWorkDueAt(state.local.work) - Date.now());
    const timer = setTimeout(() => {
      if (stateRef.current.local.status === "deferred") {
        void send();
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [state, send]);

  /** The one expiry check: timer, pageshow, visible, and focus all land here. */
  const checkAttemptExpiry = useCallback(() => {
    const local = stateRef.current.local;
    if (local.status !== "saving" || Date.now() < local.expiresAt) {
      return;
    }
    // Invalidate first, then abort: the settlement guard above sees the
    // already-expired attempt and ignores the AbortError. Restore never
    // auto-starts a replacement PATCH.
    apply({
      type: "save_failed",
      attemptId: local.attemptId,
      failure: { kind: "AttemptDeadlineExceeded" },
    });
    abortRef.current?.abort();
    abortRef.current = null;
  }, [apply]);

  useEffect(() => {
    if (state.local.status !== "saving") {
      return;
    }
    const timer = setTimeout(checkAttemptExpiry, Math.max(0, state.local.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state, checkAttemptExpiry]);

  const revalidate = useCallback(async (): Promise<void> => {
    if (revalidateInFlightRef.current || stateRef.current.local.status !== "clean") {
      return;
    }
    revalidateInFlightRef.current = true;
    const generation = intentGenerationRef.current;
    try {
      const res = await apiFetch<{ data: unknown }>("/api/me/reader-profile", {
        cache: "no-store",
      });
      const profile = parseReaderProfile(res.data);
      if (intentGenerationRef.current !== generation || stateRef.current.local.status !== "clean") {
        return;
      }
      apply({ type: "revalidated", profile });
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) {
        return;
      }
      const failure = classifyReaderProfileSaveError(err);
      if (failure.kind === "Forbidden") {
        // A forbidden read is an authorization contract regression, not a
        // save failure; defect loudly.
        throw err;
      }
      // justify-ignore-error: classified transient revalidation failure
      // retains current state until the next resume event (spec §7).
      console.error("Reader profile revalidation failed:", err);
    } finally {
      revalidateInFlightRef.current = false;
    }
  }, [apply]);

  /**
   * Lifecycle capture: flush deferred or retryable-failed work only when no
   * logical PATCH is in flight. Forbidden is never promoted.
   */
  const lifecycleFlush = useCallback(() => {
    const status = stateRef.current.local.status;
    if (status === "deferred" || status === "save_failed") {
      void send();
    }
  }, [send]);

  // justify-event-driven-get: revalidation runs only inside the registered
  // resume listeners (visible/focus/pageshow/online), never on effect run.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        lifecycleFlush();
      } else {
        checkAttemptExpiry();
        void revalidate();
      }
    };
    const onFocus = () => {
      checkAttemptExpiry();
      void revalidate();
    };
    const onPageHide = () => {
      lifecycleFlush();
    };
    const onPageShow = () => {
      checkAttemptExpiry();
      void revalidate();
    };
    const onOnline = () => {
      void revalidate();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, [checkAttemptExpiry, lifecycleFlush, revalidate]);

  // Provider teardown flushes like pagehide; the ref keeps the effect
  // mount-only so it cannot double-flush on dependency churn.
  const lifecycleFlushRef = useRef(lifecycleFlush);
  lifecycleFlushRef.current = lifecycleFlush;
  useEffect(() => () => lifecycleFlushRef.current(), []);

  const intend = useCallback(
    (patch: ReaderProfilePatch) => {
      intentGenerationRef.current += 1;
      apply({ type: "intent", patch, now: Date.now() });
    },
    [apply],
  );

  const retrySave = useCallback(() => {
    if (stateRef.current.local.status !== "save_failed") {
      throw new Error("retrySave is only available from SaveFailed");
    }
    void send();
  }, [send]);

  // Value-stable projections: transitions that change no desired pixel and no
  // persistence fact (e.g. deferred -> saving) keep both identities, so the
  // context value memo holds and reader consumers skip the re-render.
  const profileRef = useRef<ReaderProfile | null>(null);
  const profile = useMemo(() => {
    const next = desiredReaderProfile(state);
    if (profileRef.current && readerProfilesEqual(profileRef.current, next)) {
      return profileRef.current;
    }
    profileRef.current = next;
    return next;
  }, [state]);

  const persistenceRef = useRef<ReaderProfilePersistence | null>(null);
  const persistence = useMemo(() => {
    const next = readerProfilePersistence(state);
    const prev = persistenceRef.current;
    if (
      prev &&
      prev.state === next.state &&
      ("failure" in prev ? prev.failure : null) === ("failure" in next ? next.failure : null)
    ) {
      return prev;
    }
    persistenceRef.current = next;
    return next;
  }, [state]);

  return { profile, persistence, intend, retrySave };
}
