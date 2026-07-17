"use client";

/**
 * The one browser owner of reader-cursor ordering and revalidation.
 *
 * One in-flight PUT per mounted coordinator with one queued latest locator;
 * saves fire after 500 ms idle with a 5 s maximum wait during continuous
 * movement. Revalidation is event-driven only (pane activation, visible,
 * focus, pageshow, online) — no timers, no realtime transport. Decisions are
 * pure in `readerProgress.ts`; this hook owns fetches, timers, generations,
 * and listeners.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  canScheduleSave,
  initialReaderProgressState,
  parseReaderCursorSnapshot,
  pendingLocator,
  readerStateConflictCurrent,
  reduceReaderProgress,
  saveBaseRevision,
  type ReaderCursorPositioned,
  type ReaderCursorSnapshot,
  type ReaderProgressEvent,
  type ReaderProgressState,
} from "./readerProgress";
import { readerResumeStatesEqual, type ReaderResumeState } from "./types";

const SAVE_IDLE_MS = 500;
const SAVE_MAX_WAIT_MS = 5_000;

export type ReaderCapability =
  | { state: "Unavailable" }
  | { state: "Readable"; mediaId: string; locatorKind: ReaderResumeState["kind"] };

export type ApplyCursorResult = "applied" | "cancelled_by_user" | "failed";

export interface ApplyCursorCommand {
  requestId: number;
  generation: number;
  source: "remote";
  locator: ReaderResumeState;
}

export interface ReaderProgressHandoffState {
  snapshot: ReaderCursorPositioned;
  busy: boolean;
  applyFailed: boolean;
  captureUnavailable: boolean;
}

type ApiFetchFn = typeof apiFetch;

interface UseReaderProgressOptions {
  capability: ReaderCapability;
  /** Pane activity from the workspace host; adoption versus handoff depends on it. */
  isPaneActive: boolean;
  /** Fetch boundary; injectable so tests exercise the real coordinator. */
  apiFetch?: ApiFetchFn;
  /** Synchronous freshest-position capture; null when no position is available. */
  captureCurrentLocator: () => ReaderResumeState | null;
  /** Format-owned addressable application of a remote cursor, with completion. */
  applyCursor: (command: ApplyCursorCommand) => Promise<ApplyCursorResult>;
}

export interface ReaderProgress {
  /** Cursor authority for gating initial render. */
  status: "loading" | "ready" | "load_failed";
  /**
   * First Ready snapshot of the current reader generation, for cold-mount
   * seeding. `undefined` until authority is first established.
   */
  initialSnapshot: ReaderCursorSnapshot | undefined;
  /** Genuine reader movement; replaces the pending locator. */
  reportMovement: (locator: ReaderResumeState) => void;
  /** Genuine input that may not produce a locator (cancels auto-adoption). */
  noteGenuineInput: () => void;
  retryLoad: () => void;
  /** True once a cursor save has failed and remains unresolved. */
  saveFailed: boolean;
  retrySave: () => void;
  handoff: ReaderProgressHandoffState | null;
  acceptRemoteCursor: () => void;
  stayAtLocalPosition: () => void;
  /** Polite live-region text; empty when nothing to announce. */
  announcement: string;
}

export function useReaderProgress(options: UseReaderProgressOptions): ReaderProgress {
  const { capability, isPaneActive, apiFetch: fetchFn = apiFetch } = options;
  const readableMediaId = capability.state === "Readable" ? capability.mediaId : null;
  const readableLocatorKind = capability.state === "Readable" ? capability.locatorKind : null;

  const [state, dispatch] = useReducer(reduceReaderProgress, initialReaderProgressState);
  const stateRef = useRef<ReaderProgressState>(state);
  stateRef.current = state;

  const [initialSnapshot, setInitialSnapshot] = useState<ReaderCursorSnapshot | undefined>(
    undefined,
  );
  const [announcement, setAnnouncement] = useState("");
  const [applyFailed, setApplyFailed] = useState(false);
  const [captureUnavailable, setCaptureUnavailable] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);

  const generationRef = useRef(0);
  const requestSeqRef = useRef(0);
  const inputSeqRef = useRef(0);
  const dormantRef = useRef(false);
  const lastMovedAtRef = useRef(0);
  const dirtySinceRef = useRef(0);
  const revalidateInFlightRef = useRef(false);
  const applyInFlightRef = useRef(false);

  const captureRef = useRef(options.captureCurrentLocator);
  captureRef.current = options.captureCurrentLocator;
  const applyCursorRef = useRef(options.applyCursor);
  applyCursorRef.current = options.applyCursor;

  /** Reduce, mirror synchronously, and dispatch — callers act on the result. */
  const apply = useCallback((event: ReaderProgressEvent): ReaderProgressState => {
    const next = reduceReaderProgress(stateRef.current, event);
    stateRef.current = next;
    dispatch(event);
    return next;
  }, []);

  /**
   * Send the pending locator. `baseRevision` defaults to the acknowledged
   * authority revision; `Stay at this position` passes the candidate revision.
   */
  const sendCursor = useCallback(
    async (baseRevision: number, keepalive = false): Promise<void> => {
      const mediaId = readableMediaId;
      if (mediaId === null) {
        return;
      }
      const locator = pendingLocator(stateRef.current.local);
      if (locator === null) {
        return;
      }
      const generation = generationRef.current;
      requestSeqRef.current += 1;
      apply({ type: "save_started" });
      const body = { locator, base_revision: baseRevision };
      try {
        const res = await fetchFn<{ data: unknown }>(`/api/media/${mediaId}/reader-state`, {
          method: "PUT",
          body: JSON.stringify(body),
          ...(keepalive ? { keepalive } : {}),
        });
        if (generationRef.current !== generation) {
          return;
        }
        const snapshot = parseReaderCursorSnapshot(res.data);
        if (snapshot.state !== "Positioned") {
          throw new Error("Cursor write returned an Empty snapshot");
        }
        apply({ type: "save_succeeded", snapshot });
      } catch (err) {
        if (generationRef.current !== generation) {
          return;
        }
        if (handleUnauthenticatedApiError(err)) {
          return;
        }
        let conflictCurrent: ReaderCursorSnapshot | null = null;
        try {
          conflictCurrent = readerStateConflictCurrent(err);
        } catch (contractErr) {
          console.error("Malformed reader-state conflict response:", contractErr);
          apply({ type: "save_failed" });
          return;
        }
        if (conflictCurrent !== null) {
          apply({ type: "save_conflicted", current: conflictCurrent });
          return;
        }
        console.error("Failed to save reader cursor:", err);
        apply({ type: "save_failed" });
      }
    },
    [apply, fetchFn, readableMediaId],
  );

  const load = useCallback(async (): Promise<ReaderProgressState | null> => {
    const mediaId = readableMediaId;
    if (mediaId === null) {
      return null;
    }
    const generation = generationRef.current;
    apply({ type: "load_started" });
    try {
      const res = await fetchFn<{ data: unknown }>(`/api/media/${mediaId}/reader-state`);
      if (generationRef.current !== generation) {
        return null;
      }
      const snapshot = parseReaderCursorSnapshot(res.data);
      const next = apply({ type: "load_succeeded", snapshot });
      setInitialSnapshot((existing) => existing ?? snapshot);
      return next;
    } catch (err) {
      if (generationRef.current !== generation) {
        return null;
      }
      if (handleUnauthenticatedApiError(err)) {
        return null;
      }
      // Failure is failure — never an empty cursor and never a default write.
      console.error("Failed to load reader cursor:", err);
      return apply({ type: "load_failed" });
    }
  }, [apply, fetchFn, readableMediaId]);

  const applyRemote = useCallback(
    async (snapshot: ReaderCursorPositioned, auto: boolean): Promise<void> => {
      if (applyInFlightRef.current) {
        return;
      }
      applyInFlightRef.current = true;
      setHandoffBusy(true);
      const generation = generationRef.current;
      requestSeqRef.current += 1;
      try {
        const result = await applyCursorRef.current({
          requestId: requestSeqRef.current,
          generation,
          source: "remote",
          locator: snapshot.locator,
        });
        if (generationRef.current !== generation) {
          return;
        }
        if (result === "applied") {
          apply({ type: "remote_applied" });
          setApplyFailed(false);
          setCaptureUnavailable(false);
          if (auto) {
            setAnnouncement("Resumed from your most recent position.");
          }
          return;
        }
        if (result === "failed") {
          // Retain the target and show Retry.
          setApplyFailed(true);
          return;
        }
        // Cancelled by genuine input: the user keeps their viewport and the
        // candidate stays available; nothing may snap back later.
      } finally {
        applyInFlightRef.current = false;
        setHandoffBusy(false);
      }
    },
    [apply],
  );

  const revalidate = useCallback(
    async (trigger: "activation" | "visible" | "focus" | "pageshow" | "online") => {
      const mediaId = readableMediaId;
      if (mediaId === null || revalidateInFlightRef.current) {
        return;
      }
      if (stateRef.current.authority.status !== "ready") {
        if (stateRef.current.authority.status === "load_failed") {
          void load();
        }
        return;
      }
      revalidateInFlightRef.current = true;
      const generation = generationRef.current;
      const startedDormant = trigger === "pageshow" || dormantRef.current;
      const inputSeqAtStart = inputSeqRef.current;
      try {
        const res = await fetchFn<{ data: unknown }>(`/api/media/${mediaId}/reader-state`);
        if (generationRef.current !== generation) {
          return;
        }
        const snapshot = parseReaderCursorSnapshot(res.data);
        const before = stateRef.current;
        const next = apply({ type: "revalidated", snapshot });
        const becameCandidate =
          next.remote.status === "candidate" &&
          next.remote.snapshot.revision === snapshot.revision &&
          (before.remote.status !== "candidate" ||
            before.remote.snapshot.revision !== snapshot.revision);
        const autoAdopt =
          becameCandidate &&
          startedDormant &&
          inputSeqRef.current === inputSeqAtStart &&
          next.local.status === "clean";
        if (autoAdopt && next.remote.status === "candidate") {
          void applyRemote(next.remote.snapshot, true);
        }
      } catch (err) {
        // Background revalidation failure preserves the current Ready reader
        // and pending work; it never becomes Empty.
        if (generationRef.current === generation && !handleUnauthenticatedApiError(err)) {
          console.error("Reader cursor revalidation failed:", err);
        }
      } finally {
        revalidateInFlightRef.current = false;
      }
    },
    [apply, applyRemote, fetchFn, load, readableMediaId],
  );

  /**
   * Lifecycle capture: on visibility/unmount, send the freshest known
   * locator — even when nothing moved. A same-locator save still advances
   * `reader_engagement_states.last_engaged_at` without changing cursor
   * revision, so a read-only visit is never lost. No timer/polling is added;
   * this only fires from the existing visibility/pagehide/pane-deactivation/
   * teardown call sites.
   */
  const lifecycleFlush = useCallback(() => {
    const current = stateRef.current;
    const mediaId = readableMediaId;
    if (mediaId === null) {
      return;
    }
    if (current.authority.status !== "ready" || current.remote.status !== "none") {
      // No authority to save against, or an open handoff — never clobber it.
      return;
    }
    if (current.local.status === "saving") {
      // A save is already in flight; its own response settles engagement.
      return;
    }
    if (current.local.status === "dirty" || current.local.status === "save_failed") {
      const captured = captureRef.current();
      if (captured !== null && !readerResumeStatesEqual(captured, current.local.locator)) {
        apply({ type: "moved", locator: captured });
      }
      void sendCursor(saveBaseRevision(current), true);
      return;
    }
    // Clean: nothing moved. Capture and dispatch the current locator anyway
    // so the flush still fires a same-locator cursor write.
    const captured = captureRef.current();
    if (captured === null) {
      return;
    }
    apply({ type: "moved", locator: captured });
    void sendCursor(saveBaseRevision(current), true);
  }, [apply, readableMediaId, sendCursor]);

  // Generation lifecycle: reset and (re)establish authority per readable
  // media/locator-kind; Unavailable performs no progress I/O.
  useEffect(() => {
    generationRef.current += 1;
    apply({ type: "reset" });
    setInitialSnapshot(undefined);
    setAnnouncement("");
    setApplyFailed(false);
    setCaptureUnavailable(false);
    if (readableMediaId === null || readableLocatorKind === null) {
      return;
    }
    void load();
    const flushOnTeardown = () => {
      lifecycleFlush();
      generationRef.current += 1;
    };
    return flushOnTeardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readableMediaId, readableLocatorKind]);

  // Save scheduling: idle debounce with a maximum wait during continuous
  // movement. Only one PUT is in flight; queued movement follows the ack.
  useEffect(() => {
    if (!canScheduleSave(state)) {
      return;
    }
    const now = Date.now();
    const deadline = Math.min(
      lastMovedAtRef.current + SAVE_IDLE_MS,
      dirtySinceRef.current + SAVE_MAX_WAIT_MS,
    );
    const timer = setTimeout(
      () => {
        const current = stateRef.current;
        if (canScheduleSave(current)) {
          void sendCursor(saveBaseRevision(current));
        }
      },
      Math.max(0, deadline - now),
    );
    return () => clearTimeout(timer);
  }, [state, sendCursor]);

  // Return/reconnect revalidation and lifecycle capture listeners.
  useEffect(() => {
    if (readableMediaId === null) {
      return;
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        dormantRef.current = true;
        lifecycleFlush();
      } else {
        void revalidate("visible").finally(() => {
          dormantRef.current = false;
        });
      }
    };
    const onFocus = () => {
      void revalidate("focus").finally(() => {
        dormantRef.current = false;
      });
    };
    const onBlur = () => {
      dormantRef.current = true;
    };
    const onPageHide = () => {
      dormantRef.current = true;
      lifecycleFlush();
    };
    const onPageShow = () => {
      void revalidate("pageshow").finally(() => {
        dormantRef.current = false;
      });
    };
    const onOnline = () => {
      void revalidate("online");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, [lifecycleFlush, readableMediaId, revalidate]);

  // Pane activity: deactivation captures and flushes; activation revalidates.
  const wasPaneActiveRef = useRef(isPaneActive);
  useEffect(() => {
    if (readableMediaId === null) {
      wasPaneActiveRef.current = isPaneActive;
      return;
    }
    if (wasPaneActiveRef.current === isPaneActive) {
      return;
    }
    wasPaneActiveRef.current = isPaneActive;
    if (isPaneActive) {
      void revalidate("activation").finally(() => {
        dormantRef.current = false;
      });
    } else {
      dormantRef.current = true;
      lifecycleFlush();
    }
  }, [isPaneActive, lifecycleFlush, readableMediaId, revalidate]);

  const reportMovement = useCallback(
    (locator: ReaderResumeState) => {
      inputSeqRef.current += 1;
      const current = stateRef.current;
      const canonical =
        current.authority.status === "ready" && current.authority.snapshot.state === "Positioned"
          ? current.authority.snapshot.locator
          : null;
      const baseline = pendingLocator(current.local) ?? canonical;
      if (baseline !== null && readerResumeStatesEqual(baseline, locator)) {
        return;
      }
      if (current.local.status === "clean") {
        dirtySinceRef.current = Date.now();
      }
      lastMovedAtRef.current = Date.now();
      apply({ type: "moved", locator });
    },
    [apply],
  );

  const noteGenuineInput = useCallback(() => {
    inputSeqRef.current += 1;
  }, []);

  const retryLoad = useCallback(() => {
    if (stateRef.current.authority.status === "load_failed") {
      void load();
    }
  }, [load]);

  const retrySave = useCallback(() => {
    // Recovery revalidates before retrying: the failed request may have
    // committed. `load` is not used here — it would reset local state.
    void (async () => {
      const mediaId = readableMediaId;
      if (mediaId === null || stateRef.current.local.status !== "save_failed") {
        return;
      }
      const generation = generationRef.current;
      try {
        const res = await fetchFn<{ data: unknown }>(`/api/media/${mediaId}/reader-state`);
        if (generationRef.current !== generation) {
          return;
        }
        const snapshot = parseReaderCursorSnapshot(res.data);
        const next = apply({ type: "revalidated", snapshot });
        if (next.local.status === "save_failed" && next.remote.status === "none") {
          void sendCursor(saveBaseRevision(next));
        }
      } catch (err) {
        if (generationRef.current === generation && !handleUnauthenticatedApiError(err)) {
          console.error("Reader cursor save retry failed:", err);
        }
      }
    })();
  }, [apply, fetchFn, readableMediaId, sendCursor]);

  const acceptRemoteCursor = useCallback(() => {
    const current = stateRef.current;
    if (current.remote.status === "candidate") {
      void applyRemote(current.remote.snapshot, false);
    }
  }, [applyRemote]);

  const stayAtLocalPosition = useCallback(() => {
    const current = stateRef.current;
    if (current.remote.status !== "candidate") {
      return;
    }
    const captured = captureRef.current();
    if (captured === null) {
      setCaptureUnavailable(true);
      return;
    }
    setCaptureUnavailable(false);
    inputSeqRef.current += 1;
    apply({ type: "moved", locator: captured });
    // Intentionally canonicalize this viewport against the remote revision.
    void sendCursor(current.remote.snapshot.revision);
  }, [apply, sendCursor]);

  const handoff = useMemo<ReaderProgressHandoffState | null>(() => {
    if (state.remote.status !== "candidate") {
      return null;
    }
    return {
      snapshot: state.remote.snapshot,
      busy: handoffBusy,
      applyFailed,
      captureUnavailable,
    };
  }, [applyFailed, captureUnavailable, handoffBusy, state.remote]);

  return {
    status:
      state.authority.status === "ready"
        ? "ready"
        : state.authority.status === "load_failed"
          ? "load_failed"
          : "loading",
    initialSnapshot,
    reportMovement,
    noteGenuineInput,
    retryLoad,
    saveFailed: state.local.status === "save_failed",
    retrySave,
    handoff,
    acceptRemoteCursor,
    stayAtLocalPosition,
    announcement,
  };
}
