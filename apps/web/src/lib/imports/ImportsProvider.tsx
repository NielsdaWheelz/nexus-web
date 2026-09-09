"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  libraryPlacementUnknownSince,
  useLibraryPlacementRevision,
} from "@/lib/libraries/placementRevision";
import { uploadSessionHandle, type ImportRef } from "@/lib/imports/importRef";
import {
  fetchImportSummary,
  publishImportsInvalidation,
  subscribeImportsInvalidations,
  type ImportSummary,
} from "@/lib/imports/importsClient";
import {
  IMPORTS_CLOSED_PANE_WINDOW_MS,
  nextObservation,
} from "@/lib/imports/importsPolling";
import {
  removeUploadSession,
  retryUploadSession,
} from "@/lib/media/ingestionClient";
import { useIntervalPoll } from "@/lib/useIntervalPoll";

export type ImportsLoadState =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready" }
  | { readonly kind: "Failed"; readonly error: ApiError };

/**
 * What the pane's reads are keyed to. `revision` changes only when the imports
 * a reader can see may have changed, so pages and detail re-key then and never
 * on an unchanged poll; `observedAt` moves on every successful read, so the
 * query hooks ride this one schedule instead of installing a second poller.
 */
export interface ImportsObservationState {
  readonly revision: number;
  readonly observedAt: string | null;
}

export type ImportsUploadCommand =
  | {
      readonly kind: "RetryUpload";
      readonly ref: ImportRef;
      readonly file: File;
      readonly expectedGeneration: number;
    }
  | { readonly kind: "RemoveUpload"; readonly ref: ImportRef };

export interface ImportsContextValue {
  readonly summary: ImportSummary | null;
  readonly loadState: ImportsLoadState;
  readonly observation: ImportsObservationState;
  readonly pending: ReadonlySet<string>;
  refresh(): Promise<void>;
  setPaneOpen(open: boolean): void;
  dispatchUpload(command: ImportsUploadCommand): Promise<void>;
}

/** The pending identity of one command against one import (contract D7). */
export function importsPendingKey(
  ref: ImportRef,
  command: ImportsUploadCommand["kind"],
): string {
  return `${ref}|${command}`;
}

const ImportsContext = createContext<ImportsContextValue | null>(null);

export function ImportsProvider({ children }: { children: ReactNode }) {
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const placementChange = useLibraryPlacementRevision();
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [loadState, setLoadState] = useState<ImportsLoadState>({
    kind: "Loading",
  });
  const [observation, setObservation] = useState<ImportsObservationState>({
    revision: 0,
    observedAt: null,
  });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // A second click in the same tick must see the first one's key, which React
  // state cannot show until it re-renders.
  const pendingRef = useRef<ReadonlySet<string>>(pending);
  const [paneOpen, setPaneOpenState] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(true);
  const [lastWakeAtMs, setLastWakeAtMs] = useState(() => Date.now());
  const [automaticReadsEnded, setAutomaticReadsEnded] = useState(false);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);

  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dirtyReadRef = useRef(false);
  const wakeRequestedRef = useRef(false);
  const summaryRef = useRef<ImportSummary | null>(null);
  const observedPlacementRevisionRef = useRef(placementChange.revision);
  const windowFocusedRef = useRef(true);

  const read = useCallback(
    (automatic: boolean): Promise<void> => {
      if (inFlightRef.current !== null) {
        if (!automatic) dirtyReadRef.current = true;
        return inFlightRef.current;
      }
      const request = (async () => {
        let again = true;
        while (again && mountedRef.current) {
          dirtyReadRef.current = false;
          const controller = new AbortController();
          abortRef.current = controller;
          try {
            const next = await fetchImportSummary(controller.signal);
            if (!mountedRef.current || controller.signal.aborted) break;
            const previous = summaryRef.current;
            summaryRef.current = next;
            setSummary(next);
            setLoadState({ kind: "Ready" });
            setObservation((current) => ({
              revision:
                previous !== null &&
                (previous.needsAttentionCount !== next.needsAttentionCount ||
                  previous.activeCount !== next.activeCount)
                  ? current.revision + 1
                  : current.revision,
              observedAt: next.observedAt,
            }));
          } catch (error: unknown) {
            if (controller.signal.aborted || isAbortError(error)) break;
            if (!mountedRef.current) break;
            if (!handleUnauthenticated(error)) {
              if (!isApiError(error) || isSameSystemApiDefect(error)) {
                setDefect({ error });
              } else {
                setLoadState({ kind: "Failed", error });
              }
            }
            // A failed automatic read ends this observation window; the
            // last-good summary stays on screen until a wake signal or a
            // manual refresh asks again.
            if (automatic) setAutomaticReadsEnded(true);
          } finally {
            if (abortRef.current === controller) abortRef.current = null;
          }
          again = dirtyReadRef.current;
        }
      })().finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
      });
      inFlightRef.current = request;
      return request;
    },
    [handleUnauthenticated],
  );

  /**
   * Start a fresh observation window and read now. `rekey` is the difference
   * between "this data may be stale" and "this data is stale": an invalidation
   * or a manual refresh re-keys every page and detail, while a resumed tab or a
   * newly opened pane only asks again and lets the answer decide.
   */
  const wake = useCallback(
    (rekey: boolean): Promise<void> => {
      wakeRequestedRef.current = true;
      setLastWakeAtMs(Date.now());
      setAutomaticReadsEnded(false);
      if (rekey) {
        setObservation((current) => ({
          ...current,
          revision: current.revision + 1,
        }));
      }
      return read(false);
    },
    [read],
  );

  const refresh = useCallback((): Promise<void> => wake(true), [wake]);

  const setPaneOpen = useCallback(
    (open: boolean) => {
      setPaneOpenState(open);
      if (open) void wake(false);
    },
    [wake],
  );

  const dispatchUpload = useCallback(
    async (command: ImportsUploadCommand): Promise<void> => {
      const handle = uploadSessionHandle(command.ref);
      if (handle === null) {
        // justify-defect: only an upload import carries an upload session, and
        // the offer that produced this command named one.
        throw new Error(`${command.kind} needs an upload import ref`);
      }
      const key = importsPendingKey(command.ref, command.kind);
      if (pendingRef.current.has(key)) return;
      pendingRef.current = new Set(pendingRef.current).add(key);
      setPending(pendingRef.current);
      try {
        if (command.kind === "RetryUpload") {
          await retryUploadSession({
            sessionHandle: handle,
            file: command.file,
            expectedGeneration: command.expectedGeneration,
            clientMutationId: crypto.randomUUID(),
          });
        } else {
          await removeUploadSession(handle);
        }
      } catch (error) {
        if (!handleUnauthenticated(error)) throw error;
      } finally {
        const next = new Set(pendingRef.current);
        next.delete(key);
        pendingRef.current = next;
        if (mountedRef.current) setPending(next);
      }
    },
    [handleUnauthenticated],
  );

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    // Defer only to the end of this commit's effect flush. A pane mounted with
    // the provider claims the same first observation through `setPaneOpen`
    // regardless of parent/child effect order, instead of costing a second
    // immediate read; with no pane, the provider still owns one mount read. A
    // later genuine wake is never covered by this one-turn gate.
    queueMicrotask(() => {
      if (cancelled || !mountedRef.current || wakeRequestedRef.current) return;
      void wake(false);
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      dirtyReadRef.current = false;
      wakeRequestedRef.current = false;
      abortRef.current?.abort();
    };
  }, [wake]);

  useEffect(
    () =>
      subscribeImportsInvalidations(() => {
        void wake(true);
      }),
    [wake],
  );

  useEffect(() => {
    const observed = observedPlacementRevisionRef.current;
    if (placementChange.revision === observed) return;
    observedPlacementRevisionRef.current = placementChange.revision;
    if (!libraryPlacementUnknownSince(observed)) return;
    publishImportsInvalidation();
  }, [placementChange.revision]);

  useEffect(() => {
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      setDocumentVisible(visible);
      if (visible) void wake(false);
    };
    const onResume = () => void wake(false);
    const onBlur = () => {
      windowFocusedRef.current = false;
    };
    const onFocus = () => {
      if (windowFocusedRef.current) return;
      windowFocusedRef.current = true;
      void wake(false);
    };
    // A tab restored or opened in the background never fires the event until it
    // comes forward, so read the state once rather than assuming visible.
    setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [wake]);

  const activeCount = summary?.activeCount ?? 0;
  const [pollIntervalMs, setPollIntervalMs] = useState(0);
  useEffect(() => {
    const evaluate = () => {
      const next = nextObservation({
        lastWakeAtMs,
        nowMs: Date.now(),
        activeCount,
        documentVisible,
        paneOpen,
      });
      setPollIntervalMs(next.kind === "Poll" ? next.delayMs : 0);
    };
    evaluate();
    if (paneOpen) return;
    const remainingMs = lastWakeAtMs + IMPORTS_CLOSED_PANE_WINDOW_MS - Date.now();
    if (remainingMs <= 0) return;
    const expiry = window.setTimeout(evaluate, remainingMs);
    return () => window.clearTimeout(expiry);
  }, [activeCount, documentVisible, lastWakeAtMs, paneOpen]);

  // justify-polling: Imports is a composed Postgres projection and this cut adds
  // no server push plane. `nextObservation` owns the schedule: five-second reads
  // run only for known active work on a visible document, a closed pane keeps
  // them for fifteen minutes past the last wake signal, and one failed automatic
  // read ends the window. This is the only Imports poller.
  useIntervalPoll({
    enabled: pollIntervalMs > 0 && !automaticReadsEnded,
    pollIntervalMs,
    onPoll: () => read(true),
  });

  if (defect !== null) throw defect.error;

  return (
    <ImportsContext.Provider
      value={{
        summary,
        loadState,
        observation,
        pending,
        refresh,
        setPaneOpen,
        dispatchUpload,
      }}
    >
      {children}
    </ImportsContext.Provider>
  );
}

export function useImports(): ImportsContextValue {
  const value = useContext(ImportsContext);
  if (value === null) throw new Error("ImportsProvider is missing");
  return value;
}
