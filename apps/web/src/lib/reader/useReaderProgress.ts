"use client";

/**
 * The one browser owner of reader-cursor ordering and revalidation.
 *
 * One in-flight PUT per mounted coordinator with one queued latest locator;
 * saves fire after 500 ms idle with a 5 s maximum wait during continuous
 * movement. Revalidation is event-driven only (pane activation, visible,
 * focus, pageshow, online) — no timers or realtime transport. Decisions are
 * pure in `readerProgress.ts`; this hook owns timers, generations, and
 * listeners while `ReaderProgressPort` exclusively owns persistence transport.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { publishConsumptionProjectionChange } from "@/lib/consumption/projectionRevision";
import {
  canScheduleSave,
  initialReaderProgressState,
  pendingLocator,
  reduceReaderProgress,
  readerCursorSourcesEqual,
  type ReaderCursorSnapshot,
  type ReaderProgressEvent,
  type ReaderProgressState,
} from "./readerProgress";
import type { SelectedReaderSource } from "./readerIntentStore";
import type {
  ReaderProgressPort,
  ReaderProgressView,
} from "./ReaderProgressPort";
import { readerResumeStatesEqual, type ReaderResumeState } from "./types";

const SAVE_IDLE_MS = 500;
const SAVE_MAX_WAIT_MS = 5_000;

export type ReaderCapability =
  | { state: "Unavailable" }
  | {
      state: "Readable";
      mediaId: string;
      locatorKind: ReaderResumeState["kind"];
      source: SelectedReaderSource;
    };

export type ApplyCursorResult = "applied" | "cancelled_by_user" | "failed";

export type ApplyCursorCommand =
  | {
      requestId: number;
      generation: number;
      source: "remote";
      locator: ReaderResumeState;
    }
  | {
      requestId: number;
      generation: number;
      source: "canonical";
      snapshot: ReaderCursorSnapshot;
    };

export interface ReaderProgressHandoffState {
  snapshot: ReaderCursorSnapshot;
  busy: boolean;
  applyFailed: boolean;
  captureUnavailable: boolean;
  canApply: boolean;
}

/**
 * The composed session load projected as authority input. Structurally a
 * subset of `AsyncResource<ReaderProgressView>`; the composition supplies the
 * live resource states, and `retry` re-runs the whole composed load (content
 * and progress) under its single invalidation identity.
 */
export interface ComposedProgressAuthority {
  resource:
    | { readonly status: "idle" }
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly data: ReaderProgressView }
    | { readonly status: "error"; readonly error: unknown };
  retry: () => void;
}

export interface UseReaderProgressOptions {
  capability: ReaderCapability;
  /** Pane activity from the workspace host; adoption versus handoff depends on it. */
  isPaneActive: boolean;
  /** Persistence transport; hosted and native readers share this semantic seam. */
  port: ReaderProgressPort;
  /**
   * Host-injected unauthenticated-error policy (the hosted composition passes
   * the sign-in redirect handler). Returning true consumes the failure.
   */
  handleUnauthenticatedError: (error: unknown) => boolean;
  /** Publish asynchronous defects beneath the retained reader-progress boundary. */
  reportDefect: (error: unknown) => void;
  /** Synchronous freshest-position capture; null when no position is available. */
  captureCurrentLocator: () => ReaderResumeState | null;
  /** Format-owned application of a remote cursor or canonical reset snapshot. */
  applyCursor: (command: ApplyCursorCommand) => Promise<ApplyCursorResult>;
  /** A terminal web/EPUB cursor write was durably acknowledged by the server. */
  onTerminalWriteAcknowledged: () => void;
  /** Route-local programmatic Find movement fence. */
  previewLease: {
    isActive(): boolean;
  };
  /**
   * Initial authority supplied by the session's composed load transaction.
   * Consumed once per readable media/locator identity: a later
   * re-establishment of the same capability re-reads canonical state through
   * `port.load` instead of adopting the memoized composed snapshot.
   */
  composedAuthority?: ComposedProgressAuthority;
}

export interface ReaderProgress {
  /** Cursor authority for gating initial render. */
  status: "loading" | "ready" | "load_failed";
  /**
   * First Ready snapshot of the current reader generation, for cold-mount
   * seeding. `undefined` until authority is first established.
   */
  initialSnapshot: ReaderCursorSnapshot | undefined;
  /** Applicable view position; unlike authority, this never crosses sources. */
  initialLocator: ReaderResumeState | null | undefined;
  sourceStatus: "ContentChanged" | "SourceUnavailable" | null;
  syncPending: boolean;
  /** Local movement has either committed or reached the durable device outbox. */
  canSuspend: boolean;
  /** Genuine reader movement; replaces the pending locator. */
  reportMovement: (locator: ReaderResumeState) => void;
  /** Genuine input that may not produce a locator (cancels auto-adoption). */
  noteGenuineInput: () => void;
  retryLoad: () => void;
  /** True once a cursor save has failed and remains unresolved. */
  saveFailed: boolean;
  retrySave: () => void;
  /** Drain the current local writer before `ResetProgress` enters the FIFO. */
  drainForProgressReset: () => Promise<void>;
  /** Install a server-authoritative reset/replay snapshot into this mounted reader. */
  installCanonicalSnapshot: (snapshot: ReaderCursorSnapshot) => Promise<void>;
  handoff: ReaderProgressHandoffState | null;
  acceptRemoteCursor: () => void;
  stayAtLocalPosition: () => void;
  /** Polite live-region text; empty when nothing to announce. */
  announcement: string;
}

function isTerminalReaderLocator(locator: ReaderResumeState): boolean {
  return (
    (locator.kind === "web" || locator.kind === "epub") &&
    locator.locations.progression === 1 &&
    locator.locations.total_progression === 1
  );
}

function progressSnapshot(
  view: ReaderProgressView,
): ReaderCursorSnapshot {
  switch (view.kind) {
    case "Canonical": return view.snapshot;
    case "Conflict": return view.canonical;
    case "Pending":
    case "ContentChanged":
    case "SourceUnavailable": return view.baseline;
  }
}

export function useReaderProgress(
  options: UseReaderProgressOptions,
): ReaderProgress {
  const { capability, isPaneActive, port } = options;
  const readableMediaId =
    capability.state === "Readable" ? capability.mediaId : null;
  const readableLocatorKind =
    capability.state === "Readable" ? capability.locatorKind : null;

  const [state, dispatch] = useReducer(
    reduceReaderProgress,
    initialReaderProgressState,
  );
  const stateRef = useRef<ReaderProgressState>(state);
  stateRef.current = state;

  const [initialSnapshot, setInitialSnapshot] = useState<
    ReaderCursorSnapshot | undefined
  >(undefined);
  const [initialLocator, setInitialLocator] = useState<ReaderResumeState | null | undefined>();
  const [sourceStatus, updateSourceStatus] = useState<ReaderProgress["sourceStatus"]>(null);
  const sourceStatusRef = useRef<ReaderProgress["sourceStatus"]>(null);
  const setSourceStatus = useCallback((status: ReaderProgress["sourceStatus"]) => {
    sourceStatusRef.current = status;
    updateSourceStatus(status);
  }, []);
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
  const applyIdRef = useRef(0);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const captureSeqRef = useRef(0);

  const captureRef = useRef(options.captureCurrentLocator);
  captureRef.current = options.captureCurrentLocator;
  const applyCursorRef = useRef(options.applyCursor);
  applyCursorRef.current = options.applyCursor;
  const onTerminalWriteAcknowledgedRef = useRef(
    options.onTerminalWriteAcknowledged,
  );
  onTerminalWriteAcknowledgedRef.current = options.onTerminalWriteAcknowledged;
  const handleUnauthenticatedErrorRef = useRef(
    options.handleUnauthenticatedError,
  );
  handleUnauthenticatedErrorRef.current = options.handleUnauthenticatedError;
  const reportDefectRef = useRef(options.reportDefect);
  reportDefectRef.current = options.reportDefect;
  const reportFailure = useCallback((error: unknown) => {
    if (!isAbortError(error) && (!isApiError(error) || isSameSystemApiDefect(error))) {
      reportDefectRef.current(error);
    }
  }, []);
  const composedAuthorityRef = useRef(options.composedAuthority);
  composedAuthorityRef.current = options.composedAuthority;
  // "composed" while the current generation's authority mirrors the session's
  // composed load; "port" once this hook owns its own `port.load` reads. The
  // consumed key makes composed adoption once-per-identity so a re-established
  // capability re-reads canonical state (fresh CAS base) from the port.
  const authorityChannelRef = useRef<"composed" | "port">("port");
  const composedConsumedKeyRef = useRef<string | null>(null);

  /** Reduce, mirror synchronously, and dispatch — callers act on the result. */
  const apply = useCallback(
    (event: ReaderProgressEvent): ReaderProgressState => {
      const next = reduceReaderProgress(stateRef.current, event);
      stateRef.current = next;
      dispatch(event);
      return next;
    },
    [],
  );

  const captureIntent = useCallback((locator: ReaderResumeState): void => {
    if (readableMediaId === null || stateRef.current.authority.status !== "ready") return;
    const generation = generationRef.current;
    const sequence = ++captureSeqRef.current;
    void port.capture(readableMediaId, locator).then((result) => {
      if (generationRef.current !== generation || captureSeqRef.current !== sequence) return;
      if (result.kind === "ContentChanged" || result.kind === "SourceUnavailable") {
        setSourceStatus(result.kind);
        const selected = stateRef.current.source;
        if (selected === null || !readerCursorSourcesEqual(selected, result.view.source) ||
            !readerResumeStatesEqual(locator, result.view.device)) {
          apply({ type: "capture_failed" });
        }
      }
    }).catch((error: unknown) => {
      if (generationRef.current !== generation || captureSeqRef.current !== sequence) return;
      console.error("Failed to retain reader cursor on this device:", error);
      apply({ type: "capture_failed" });
      reportFailure(error);
    });
  }, [apply, port, readableMediaId, reportFailure, setSourceStatus]);

  const observeView = useCallback((view: ReaderProgressView, initial: boolean): ReaderProgressState => {
    const snapshot = progressSnapshot(view);
    const current = stateRef.current;
    const knownRevision = Math.max(
      current.authority.status === "ready" ? current.authority.snapshot.revision : 0,
      current.remote.status === "candidate" ? current.remote.snapshot.revision : 0,
    );
    if (!initial && (view.kind === "Canonical" || view.kind === "Conflict") &&
        snapshot.revision < knownRevision) return current;
    const waitingMovement = initial && stateRef.current.authority.status !== "ready"
      ? pendingLocator(stateRef.current.local) : null;
    const selected = stateRef.current.source;
    const deviceApplies = view.kind !== "Canonical" && selected !== null &&
      readerCursorSourcesEqual(selected, view.source);
    setSourceStatus(view.kind === "ContentChanged" || view.kind === "SourceUnavailable" ? view.kind
      : view.kind !== "Canonical" && !deviceApplies ? "ContentChanged" : null);
    let next = apply({ type: initial ? "load_succeeded" : "revalidated", snapshot });
    if (deviceApplies && (view.kind === "Pending" || view.kind === "Conflict")) {
      if (next.local.status === "clean") next = apply({ type: "moved", locator: view.device });
      if (view.kind === "Conflict" && next.local.status !== "saving") {
        apply({ type: "save_started" });
        next = apply({ type: "save_conflicted", current: view.canonical });
      }
    }
    if (initial) {
      setInitialSnapshot((existing) => existing ?? snapshot);
      const applicable = view.kind !== "Canonical" && deviceApplies ? view.device
        : view.kind === "Canonical" && snapshot.state === "Positioned" && selected !== null &&
          readerCursorSourcesEqual(selected, snapshot.source) ? snapshot.locator : null;
      setInitialLocator((existing) => existing === undefined ? applicable : existing);
    }
    if (waitingMovement !== null && pendingLocator(next.local) !== null) {
      captureIntent(waitingMovement);
    }
    return next;
  }, [apply, captureIntent, setSourceStatus]);

  /** Flush the persisted attempt; the port owns its frozen revision. */
  const sendCursor = useCallback(
    (keepalive = false): Promise<void> => {
      const run = async (): Promise<void> => {
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
        try {
          const result = await port.flush(mediaId, {
            ...(keepalive ? { keepalive: true } : {}),
          });
          if (generationRef.current !== generation) {
            return;
          }
          if (result.kind === "Conflict") {
            apply({ type: "save_conflicted", current: result.canonical });
            return;
          }
          if (result.kind !== "Canonical") {
            apply({ type: "save_pending" });
            setSourceStatus(result.kind === "ContentChanged" || result.kind === "SourceUnavailable" ? result.kind : null);
            return;
          }
          setSourceStatus(null);
          const snapshot = result.snapshot;
          if (snapshot.state !== "Positioned") {
            throw new Error("Cursor write returned an Empty snapshot");
          }
          apply({ type: "save_succeeded", snapshot });
          // A durable reader-state write can change read_state/InProgress.
          publishConsumptionProjectionChange();
          if (
            isTerminalReaderLocator(locator) &&
            isTerminalReaderLocator(snapshot.locator) &&
            readerResumeStatesEqual(locator, snapshot.locator)
          ) {
            try {
              onTerminalWriteAcknowledgedRef.current();
            } catch (error) {
              // The cursor has already been acknowledged. A consumer-owned
              // follow-up cannot turn that durable success into a save failure.
              console.error(
                "Terminal reader cursor acknowledgement failed:",
                error,
              );
              reportFailure(error);
            }
          }
        } catch (err) {
          if (generationRef.current !== generation) {
            return;
          }
          if (handleUnauthenticatedErrorRef.current(err)) {
            return;
          }
          console.error("Failed to save reader cursor:", err);
          apply({ type: "save_failed" });
          reportFailure(err);
        }
      };
      const pending = run();
      saveInFlightRef.current = pending;
      void pending.then(
        () => {
          if (saveInFlightRef.current === pending) {
            saveInFlightRef.current = null;
          }
        },
        () => {
          if (saveInFlightRef.current === pending) {
            saveInFlightRef.current = null;
          }
        },
      );
      return pending;
    },
    [apply, port, readableMediaId, reportFailure, setSourceStatus],
  );

  const load = useCallback(async (): Promise<ReaderProgressState | null> => {
    const mediaId = readableMediaId;
    if (mediaId === null) {
      return null;
    }
    const generation = generationRef.current;
    apply({ type: "load_started" });
    try {
      const view = await port.load(mediaId);
      if (generationRef.current !== generation) {
        return null;
      }
      return observeView(view, true);
    } catch (err) {
      if (generationRef.current !== generation) {
        return null;
      }
      if (handleUnauthenticatedErrorRef.current(err)) {
        return null;
      }
      // Failure is failure — never an empty cursor and never a default write.
      console.error("Failed to load reader cursor:", err);
      reportFailure(err);
      return apply({ type: "load_failed" });
    }
  }, [apply, observeView, port, readableMediaId, reportFailure]);

  /**
   * Re-establish failed authority through its owning channel: the composed
   * session load retries as one identity (content and progress together);
   * port-owned authority re-reads canonical state directly.
   */
  const recoverAuthority = useCallback(() => {
    if (stateRef.current.authority.status !== "load_failed") {
      return;
    }
    const composed = composedAuthorityRef.current;
    if (authorityChannelRef.current === "composed" && composed !== undefined) {
      composed.retry();
      return;
    }
    void load();
  }, [load]);

  const applyRemote = useCallback(
    async (snapshot: ReaderCursorSnapshot, auto: boolean): Promise<void> => {
      const selected = stateRef.current.source;
      if (snapshot.state === "Positioned" &&
          (selected === null || !readerCursorSourcesEqual(selected, snapshot.source))) {
        setSourceStatus("ContentChanged");
        return;
      }
      if (applyInFlightRef.current) {
        return;
      }
      applyInFlightRef.current = true;
      const applyId = ++applyIdRef.current;
      setHandoffBusy(true);
      const generation = generationRef.current;
      requestSeqRef.current += 1;
      try {
        const result = await applyCursorRef.current(
          snapshot.state === "Positioned"
            ? {
                requestId: requestSeqRef.current,
                generation,
                source: "remote",
                locator: snapshot.locator,
              }
            : {
                requestId: requestSeqRef.current,
                generation,
                source: "canonical",
                snapshot,
              },
        );
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
      } catch (error) {
        if (generationRef.current === generation) {
          console.error("Failed to apply reader cursor:", error);
          reportFailure(error);
          setApplyFailed(true);
        }
      } finally {
        if (applyIdRef.current === applyId) {
          applyInFlightRef.current = false;
          setHandoffBusy(false);
        }
      }
    },
    [apply, reportFailure, setSourceStatus],
  );

  const installCanonicalSnapshot = useCallback(
    async (snapshot: ReaderCursorSnapshot): Promise<void> => {
      if (readableMediaId === null) {
        return;
      }
      // Fence callbacks from before reset, then reconcile the durable writer.
      // A reset receipt never authorizes deleting a competing pending intent.
      generationRef.current += 1;
      const generation = generationRef.current;
      requestSeqRef.current += 1;
      let view: ReaderProgressView;
      try {
        view = await port.load(readableMediaId);
        if (generationRef.current !== generation) return;
        if ((view.kind === "Canonical" || view.kind === "Conflict") &&
            progressSnapshot(view).revision < snapshot.revision) {
          throw new Error("Reader authority predates its committed reset");
        }
      } catch (error) {
        if (generationRef.current === generation) {
          reportFailure(error);
          setApplyFailed(true);
        }
        return;
      }
      if (view.kind !== "Canonical" || view.snapshot.revision !== snapshot.revision) {
        observeView(view, false);
        return;
      }
      snapshot = view.snapshot;
      apply({ type: "canonical_snapshot_installed", snapshot });
      setInitialSnapshot(snapshot);
      const selected = stateRef.current.source;
      const applicable = snapshot.state === "Empty" || (selected !== null && readerCursorSourcesEqual(selected, snapshot.source));
      setInitialLocator(applicable && snapshot.state === "Positioned" ? snapshot.locator : null);
      setSourceStatus(applicable ? null : "ContentChanged");
      setAnnouncement("");
      setApplyFailed(false);
      setCaptureUnavailable(false);
      if (!applicable) return;

      applyInFlightRef.current = true;
      const applyId = ++applyIdRef.current;
      setHandoffBusy(true);
      try {
        const result = await applyCursorRef.current({
          requestId: requestSeqRef.current,
          generation,
          source: "canonical",
          snapshot,
        });
        if (generationRef.current !== generation) {
          return;
        }
        if (result !== "applied") {
          setApplyFailed(true);
        }
      } catch (error) {
        if (generationRef.current === generation) {
          console.error("Failed to install canonical reader cursor:", error);
          reportFailure(error);
          setApplyFailed(true);
        }
      } finally {
        if (applyIdRef.current === applyId) {
          applyInFlightRef.current = false;
          setHandoffBusy(false);
        }
      }
    },
    [apply, observeView, port, readableMediaId, reportFailure, setSourceStatus],
  );

  const drainForProgressReset = useCallback(async (): Promise<void> => {
    // Finish the one already-started write, then flush the newest queued local
    // locator once. The server tombstone remains the race boundary if a write
    // is ambiguous or new input races this best-effort drain.
    const inFlight = saveInFlightRef.current;
    if (inFlight !== null) {
      await inFlight;
    }
    const current = stateRef.current;
    if (
      current.authority.status === "ready" &&
      current.remote.status === "none" &&
      (current.local.status === "dirty" ||
        current.local.status === "save_failed" || current.local.status === "pending")
    ) {
      await sendCursor();
    }
  }, [sendCursor]);

  const revalidate = useCallback(
    async (
      trigger: "activation" | "visible" | "focus" | "pageshow" | "online",
    ) => {
      const mediaId = readableMediaId;
      if (mediaId === null || revalidateInFlightRef.current) {
        return;
      }
      if (stateRef.current.authority.status !== "ready") {
        if (stateRef.current.authority.status === "load_failed") {
          recoverAuthority();
        }
        return;
      }
      revalidateInFlightRef.current = true;
      const generation = generationRef.current;
      const startedDormant = trigger === "pageshow" || dormantRef.current;
      const inputSeqAtStart = inputSeqRef.current;
      try {
        const view = await port.load(mediaId);
        if (generationRef.current !== generation) {
          return;
        }
        const snapshot = progressSnapshot(view);
        const before = stateRef.current;
        const next = observeView(view, false);
        const becameCandidate =
          next.remote.status === "candidate" &&
          next.remote.snapshot.revision === snapshot.revision &&
          (before.remote.status !== "candidate" ||
            before.remote.snapshot.revision !== snapshot.revision);
        const autoAdopt =
          becameCandidate &&
          view.kind === "Canonical" &&
          (snapshot.state === "Empty" || (next.source !== null && readerCursorSourcesEqual(next.source, snapshot.source))) &&
          startedDormant &&
          inputSeqRef.current === inputSeqAtStart &&
          next.local.status === "clean";
        if (autoAdopt && next.remote.status === "candidate") {
          void applyRemote(next.remote.snapshot, true);
          return;
        }
        // Reconnecting or returning is a delivery opportunity: a durably
        // pending attempt resumes here instead of waiting for newer movement or
        // for the user. The port replays its frozen attempt, not a new write.
        if (next.local.status === "pending" && next.remote.status === "none") {
          void sendCursor();
        }
      } catch (err) {
        // Background revalidation failure preserves the current Ready reader
        // and pending work; it never becomes Empty.
        if (
          generationRef.current === generation &&
          !handleUnauthenticatedErrorRef.current(err)
        ) {
          console.error("Reader cursor revalidation failed:", err);
          reportFailure(err);
        }
      } finally {
        revalidateInFlightRef.current = false;
      }
    },
    [applyRemote, observeView, port, readableMediaId, recoverAuthority, reportFailure, sendCursor],
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
    if (
      current.authority.status !== "ready" ||
      current.remote.status !== "none"
    ) {
      // No authority to save against, or an open handoff — never clobber it.
      return;
    }
    if (current.local.status === "saving") {
      // A save is already in flight; its own response settles engagement.
      return;
    }
    if (options.previewLease.isActive()) {
      // A dirty locator predating the preview may still be flushed unchanged.
      // A clean reader must not capture or engage the preview viewport.
      if (
        current.local.status === "dirty" ||
        current.local.status === "save_failed" || current.local.status === "pending"
      ) {
        void sendCursor(true);
      }
      return;
    }
    if (
      current.local.status === "dirty" ||
      current.local.status === "save_failed" || current.local.status === "pending"
    ) {
      if (!isTerminalReaderLocator(current.local.locator)) {
        const captured = captureRef.current();
        if (
          captured !== null &&
          !readerResumeStatesEqual(captured, current.local.locator)
        ) {
          apply({ type: "moved", locator: captured });
          captureIntent(captured);
        }
      }
      void sendCursor(true);
      return;
    }
    if (sourceStatusRef.current !== null) return;
    const snapshot = current.authority.snapshot;
    if (snapshot.state === "Positioned" &&
        (current.source === null || !readerCursorSourcesEqual(current.source, snapshot.source))) return;
    // Clean: nothing moved. Capture and dispatch the current locator anyway
    // so the flush still fires a same-locator cursor write.
    const captured = captureRef.current();
    if (captured === null) {
      return;
    }
    apply({ type: "moved", locator: captured });
    captureIntent(captured);
    void sendCursor(true);
  }, [apply, captureIntent, options.previewLease, readableMediaId, sendCursor]);
  // Teardown flushes the current lifecycle closure: the generation effect below
  // is keyed on the reader identity and never re-subscribes for a new one.
  const lifecycleFlushRef = useRef(lifecycleFlush);
  lifecycleFlushRef.current = lifecycleFlush;

  // Generation lifecycle: reset and (re)establish authority per readable
  // media/locator-kind; Unavailable performs no progress I/O.
  useEffect(() => {
    generationRef.current += 1;
    apply({ type: "reset", source: capability.state === "Readable" ? capability.source : null });
    setInitialSnapshot(undefined);
    setInitialLocator(undefined);
    setSourceStatus(null);
    setAnnouncement("");
    setApplyFailed(false);
    setCaptureUnavailable(false);
    if (readableMediaId === null || readableLocatorKind === null) {
      return;
    }
    if (capability.state === "Readable") port.bindSource(readableMediaId, capability.source);
    const detach = port.attach();
    const composedKey = JSON.stringify([readableMediaId, readableLocatorKind, stateRef.current.source]);
    if (
      composedAuthorityRef.current !== undefined &&
      composedConsumedKeyRef.current !== composedKey
    ) {
      // First establishment for this identity adopts the session's composed
      // load; the composed-resource effect below mirrors its lifecycle. A
      // re-established identical capability re-reads canonical state through
      // the port so a memoized composed revision never becomes the CAS base.
      composedConsumedKeyRef.current = composedKey;
      authorityChannelRef.current = "composed";
    } else {
      authorityChannelRef.current = "port";
      void load();
    }
    const flushOnTeardown = () => {
      lifecycleFlushRef.current();
      generationRef.current += 1;
      detach();
    };
    return flushOnTeardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: this effect owns the progress generation, so it must run once per readable identity; re-running it for a new `apply`, `load` or `capability` object identity would bump the generation, detach the live writer and re-load mid-visit. Teardown reads `lifecycleFlushRef`, so the pending flush is never a stale closure, and a changed publication generation arrives as a new reader identity.
  }, [readableMediaId, readableLocatorKind, port]);

  // Composed-authority mirror: while this generation's authority is sourced
  // from the composed session load, project that resource's lifecycle into
  // the reducer. Retry/backoff, unauthenticated redirect, and defect routing
  // live in the resource owner, so this only mirrors settled states.
  const composedResource = options.composedAuthority?.resource;
  useEffect(() => {
    if (
      authorityChannelRef.current !== "composed" ||
      composedResource === undefined
    ) {
      return;
    }
    switch (composedResource.status) {
      case "idle":
        return;
      case "loading":
        if (stateRef.current.authority.status !== "loading") {
          apply({ type: "load_started" });
        }
        return;
      case "ready": {
        if (stateRef.current.authority.status === "ready") {
          return;
        }
        observeView(composedResource.data, true);
        return;
      }
      case "error":
        if (stateRef.current.authority.status !== "load_failed") {
          // Failure is failure — never an empty cursor and never a default
          // write.
          console.error(
            "Failed to load reader cursor:",
            composedResource.error,
          );
          apply({ type: "load_failed" });
        }
        return;
    }
  }, [apply, composedResource, observeView]);

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
          void sendCursor();
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
      if (options.previewLease.isActive()) {
        return;
      }
      inputSeqRef.current += 1;
      const current = stateRef.current;
      const canonical =
        current.authority.status === "ready" &&
        current.authority.snapshot.state === "Positioned" &&
        current.source !== null && readerCursorSourcesEqual(current.source, current.authority.snapshot.source)
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
      captureIntent(locator);
    },
    [apply, captureIntent, options.previewLease],
  );

  const noteGenuineInput = useCallback(() => {
    inputSeqRef.current += 1;
  }, []);

  const retryLoad = useCallback(() => {
    recoverAuthority();
  }, [recoverAuthority]);

  const retrySave = useCallback(() => {
    // Recovery revalidates before retrying: the failed request may have
    // committed. `load` is not used here — it would reset local state.
    void (async () => {
      const mediaId = readableMediaId;
      if (mediaId === null || (stateRef.current.local.status !== "save_failed" && stateRef.current.local.status !== "pending")) {
        return;
      }
      const generation = generationRef.current;
      try {
        const view = await port.load(mediaId);
        if (generationRef.current !== generation) {
          return;
        }
        const next = observeView(view, false);
        if (
          (next.local.status === "save_failed" || next.local.status === "pending") &&
          next.remote.status === "none"
        ) {
          const locator = pendingLocator(next.local);
          if (locator !== null) await port.capture(mediaId, locator);
          void sendCursor();
        }
      } catch (err) {
        if (
          generationRef.current === generation &&
          !handleUnauthenticatedErrorRef.current(err)
        ) {
          console.error("Reader cursor save retry failed:", err);
          reportFailure(err);
        }
      }
    })();
  }, [observeView, port, readableMediaId, reportFailure, sendCursor]);

  const acceptRemoteCursor = useCallback(() => {
    const current = stateRef.current;
    if (current.remote.status !== "candidate" || readableMediaId === null) return;
    const expected = current.remote.snapshot;
    const generation = generationRef.current;
    void port.resolve(readableMediaId, "Canonical").then((view) => {
      if (generationRef.current !== generation) return;
      const snapshot = progressSnapshot(view);
      if (view.kind !== "Canonical" || snapshot.revision !== expected.revision) {
        observeView(view, false);
        return;
      }
      void applyRemote(snapshot, false);
    }).catch((error: unknown) => {
      if (generationRef.current !== generation) return;
      console.error("Failed to resolve reader position:", error);
      reportFailure(error);
      setApplyFailed(true);
    });
  }, [applyRemote, observeView, port, readableMediaId, reportFailure]);

  const stayAtLocalPosition = useCallback(() => {
    const current = stateRef.current;
    if (current.remote.status !== "candidate" || readableMediaId === null) {
      return;
    }
    const pending = pendingLocator(current.local);
    const captured =
      pending !== null && isTerminalReaderLocator(pending)
        ? pending
        : captureRef.current();
    if (captured === null) {
      setCaptureUnavailable(true);
      return;
    }
    setCaptureUnavailable(false);
    inputSeqRef.current += 1;
    apply({ type: "moved", locator: captured });
    const expectedRevision = current.remote.snapshot.revision;
    const generation = generationRef.current;
    setHandoffBusy(true);
    void (async () => {
      await port.capture(readableMediaId, captured);
      await sendCursor();
      if (generationRef.current !== generation) return;
      const observed = stateRef.current.remote;
      if (observed.status !== "candidate" || observed.snapshot.revision !== expectedRevision) return;
      apply({ type: "save_started" });
      const view = await port.resolve(readableMediaId, "Device");
      if (generationRef.current !== generation) return;
      if (view.kind === "Canonical" && view.snapshot.state === "Positioned") {
        apply({ type: "save_succeeded", snapshot: view.snapshot });
        publishConsumptionProjectionChange();
      } else if (view.kind === "Conflict") {
        apply({ type: "save_conflicted", current: view.canonical });
      } else {
        observeView(view, false);
        apply({ type: "save_pending" });
      }
    })().catch((error: unknown) => {
      if (generationRef.current !== generation) return;
      console.error("Failed to keep reader position:", error);
      reportFailure(error);
      apply({ type: "capture_failed" });
    }).finally(() => { if (generationRef.current === generation) setHandoffBusy(false); });
  }, [apply, observeView, port, readableMediaId, reportFailure, sendCursor]);

  const handoff = useMemo<ReaderProgressHandoffState | null>(() => {
    if (state.remote.status !== "candidate") {
      return null;
    }
    return {
      snapshot: state.remote.snapshot,
      busy: handoffBusy,
      applyFailed,
      captureUnavailable,
      canApply: state.remote.snapshot.state === "Empty" || (state.source !== null &&
        readerCursorSourcesEqual(state.source, state.remote.snapshot.source)),
    };
  }, [applyFailed, captureUnavailable, handoffBusy, state.remote, state.source]);

  return {
    status:
      state.authority.status === "ready"
        ? "ready"
        : state.authority.status === "load_failed"
          ? "load_failed"
          : "loading",
    initialSnapshot,
    initialLocator,
    sourceStatus,
    syncPending: state.local.status === "pending",
    canSuspend: state.local.status === "clean" || state.local.status === "pending",
    reportMovement,
    noteGenuineInput,
    retryLoad,
    saveFailed: state.local.status === "save_failed",
    retrySave,
    drainForProgressReset,
    installCanonicalSnapshot,
    handoff,
    acceptRemoteCursor,
    stayAtLocalPosition,
    announcement,
  };
}
