"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PaneFindResult,
  PaneFindResultKey,
  PaneFindResultRow,
  PaneFindScopeControl,
  PaneFindScopeOption,
  PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import { truncatePaneSearchQuery } from "@/lib/panes/paneSearch";

export const PANE_FIND_INPUT_DELAY_MS = 120;

export interface PaneFindSessionRequest {
  readonly sessionId: number;
  readonly sourceKey: PaneFindSourceKey;
  readonly signal: AbortSignal;
}

export type PaneFindPrepareRequest = PaneFindSessionRequest;

export interface PaneFindSession {
  readonly sessionId: number;
  readonly sourceKey: PaneFindSourceKey;
  readonly scopes: readonly PaneFindScopeOption[];
}

export interface PaneFindRequest extends PaneFindSessionRequest {
  readonly queryId: number;
  readonly query: string;
  readonly scopeId: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
}

export interface PaneFindPreviewRequest extends PaneFindSessionRequest {
  readonly queryId: number;
  readonly key: PaneFindResultKey;
}

export type PaneFindResponse<TError> =
  | {
      readonly kind: "Ready";
      readonly sessionId: number;
      readonly queryId: number;
      readonly sourceKey: PaneFindSourceKey;
      readonly completeness: "Complete" | "Partial";
      readonly rows: readonly PaneFindResultRow[];
      readonly initialActiveKey: PaneFindResultKey;
    }
  | {
      readonly kind: "NoMatches";
      readonly sessionId: number;
      readonly queryId: number;
      readonly sourceKey: PaneFindSourceKey;
      readonly completeness: "Complete" | "Partial";
    }
  | {
      readonly kind: "TooManyMatches";
      readonly sessionId: number;
      readonly queryId: number;
      readonly sourceKey: PaneFindSourceKey;
      readonly threshold: number;
    }
  | {
      readonly kind: "Failed";
      readonly sessionId: number;
      readonly queryId: number;
      readonly sourceKey: PaneFindSourceKey;
      readonly error: TError;
    };

export type PaneFindPreviewReceipt<TError> =
  | {
      readonly kind: "Previewed";
      readonly sessionId: number;
      readonly queryId: number;
      readonly sourceKey: PaneFindSourceKey;
      readonly key: PaneFindResultKey;
      readonly returnAvailable: true;
    }
  | {
      readonly kind: "Rejected";
      readonly sessionId: number;
      readonly queryId: number;
      readonly sourceKey: PaneFindSourceKey;
      readonly key: PaneFindResultKey;
      readonly error: TError;
    };

export interface PaneFindAdapter<TError> {
  readonly sourceKey: PaneFindSourceKey;
  prepare(request: PaneFindPrepareRequest): Promise<PaneFindSession>;
  find(request: PaneFindRequest): Promise<PaneFindResponse<TError>>;
  preview(
    request: PaneFindPreviewRequest,
  ): Promise<PaneFindPreviewReceipt<TError>>;
  clearPresentation(request: PaneFindSessionRequest): Promise<void>;
  returnToReadingPosition(request: PaneFindSessionRequest): Promise<void>;
  errorMessage(error: TError): string;
}

export type PaneFindCapability<TError> =
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Available";
      readonly adapter: PaneFindAdapter<TError>;
    };

export interface PaneFindController {
  readonly query: string;
  readonly result: PaneFindResult;
  readonly scope: PaneFindScopeControl;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly returnToReadingPosition:
    | { readonly kind: "Unavailable" }
    | { readonly kind: "Available"; readonly onReturn: () => void };
  readonly onOpen: () => void;
  readonly onQueryChange: (query: string) => void;
  readonly onDismiss: () => void;
  readonly onMatchCaseChange: (value: boolean) => void;
  readonly onWholeWordChange: (value: boolean) => void;
  readonly onStep: (direction: "Previous" | "Next") => void;
  readonly onActivate: (key: PaneFindResultKey) => Promise<boolean>;
}

export type PaneFindUseResult =
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Available";
      readonly controller: PaneFindController;
    };

type PreparedState =
  | { readonly kind: "Preparing" }
  | { readonly kind: "Ready"; readonly session: PaneFindSession };

type ReadyResult = Extract<PaneFindResult, { readonly kind: "Ready" }>;

interface PreviewAttempt {
  readonly key: PaneFindResultKey;
  readonly queryId: number;
  readonly ready: ReadyResult;
}

type PreviewSettlement =
  | { readonly kind: "Stale" }
  | { readonly kind: "Current"; readonly reprepare: boolean };

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function entireResourceScope(
  scopes: readonly PaneFindScopeOption[],
): PaneFindScopeOption {
  const entire = scopes.filter((scope) => scope.kind === "EntireResource");
  if (entire.length !== 1) {
    throw new Error("Pane Find requires exactly one EntireResource scope.");
  }
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (!scope.id || ids.has(scope.id)) {
      throw new Error("Pane Find scope ids must be non-empty and unique.");
    }
    ids.add(scope.id);
  }
  return entire[0]!;
}

function readyResult(input: {
  readonly rows: readonly PaneFindResultRow[];
  readonly activeKey: PaneFindResultKey;
  readonly completeness: "Complete" | "Partial";
}): PaneFindResult {
  if (input.rows.length === 0) {
    throw new Error("Pane Find Ready requires at least one row.");
  }
  const keys = new Set<PaneFindResultKey>();
  let activeCount = 0;
  for (const row of input.rows) {
    if (keys.has(row.key)) {
      throw new Error(`Duplicate Pane Find result key: ${row.key}`);
    }
    keys.add(row.key);
    if (row.key === input.activeKey) activeCount += 1;
  }
  if (activeCount !== 1) {
    throw new Error("Pane Find active result must occur exactly once.");
  }
  return {
    kind: "Ready",
    rows: input.rows,
    activeKey: input.activeKey,
    completeness: input.completeness,
  };
}

export function usePaneFind<TError>({
  capability,
}: {
  readonly capability: PaneFindCapability<TError>;
}): PaneFindUseResult {
  const adapter =
    capability.kind === "Available" ? capability.adapter : undefined;
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [prepared, setPrepared] = useState<PreparedState>({
    kind: "Preparing",
  });
  const [selectedScopeId, setSelectedScopeId] = useState("");
  const [result, setResult] = useState<PaneFindResult>({ kind: "Idle" });
  const [returnAvailable, setReturnAvailable] = useState(false);
  const [defect, setDefect] = useState<unknown>(null);
  const sessionIdRef = useRef(0);
  const queryIdRef = useRef(0);
  const prepareAbortRef = useRef<AbortController | null>(null);
  const queryAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const clearAbortRef = useRef<AbortController | null>(null);
  const returnAbortRef = useRef<AbortController | null>(null);
  const returnInFlightRef = useRef(false);
  const queryTimerRef = useRef<number | null>(null);
  const previewGenerationRef = useRef(0);
  const previewInFlightRef = useRef(0);
  const reprepareAfterPreviewRef = useRef(false);
  const preparedRef = useRef(prepared);
  const resultRef = useRef(result);
  const returnAvailableRef = useRef(returnAvailable);
  preparedRef.current = prepared;
  resultRef.current = result;
  returnAvailableRef.current = returnAvailable;

  const setReturnAvailability = useCallback((available: boolean) => {
    returnAvailableRef.current = available;
    setReturnAvailable(available);
  }, []);

  const beginPreviewAttempt = useCallback(() => {
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    previewInFlightRef.current = 1;
    return generation;
  }, []);

  const settlePreviewAttempt = useCallback(
    ({
      generation,
      capturedOrigin,
    }: {
      readonly generation: number;
      readonly capturedOrigin: boolean;
    }): PreviewSettlement => {
      if (generation !== previewGenerationRef.current) {
        return { kind: "Stale" };
      }
      previewInFlightRef.current = 0;
      if (capturedOrigin) {
        reprepareAfterPreviewRef.current = false;
        setReturnAvailability(true);
        return { kind: "Current", reprepare: false };
      }
      if (reprepareAfterPreviewRef.current && !returnAvailableRef.current) {
        reprepareAfterPreviewRef.current = false;
        return { kind: "Current", reprepare: true };
      }
      return { kind: "Current", reprepare: false };
    },
    [setReturnAvailability],
  );

  const defectAsync = useCallback((error: unknown) => {
    if (!isAbort(error)) setDefect(error);
  }, []);

  const clearCurrentPresentation = useCallback(() => {
    const current = preparedRef.current;
    if (!adapter || current.kind !== "Ready") return;
    clearAbortRef.current?.abort();
    const abort = new AbortController();
    clearAbortRef.current = abort;
    void adapter
      .clearPresentation({
        sessionId: current.session.sessionId,
        sourceKey: current.session.sourceKey,
        signal: abort.signal,
      })
      .catch(defectAsync);
  }, [adapter, defectAsync]);

  const startPreparation = useCallback(
    ({ resetMatchOptions }: { readonly resetMatchOptions: boolean }) => {
      if (!adapter) return;
      const sessionId = sessionIdRef.current + 1;
      sessionIdRef.current = sessionId;
      queryIdRef.current = 0;
      previewGenerationRef.current += 1;
      previewInFlightRef.current = 0;
      reprepareAfterPreviewRef.current = false;
      if (queryTimerRef.current !== null) {
        window.clearTimeout(queryTimerRef.current);
        queryTimerRef.current = null;
      }
      prepareAbortRef.current?.abort();
      queryAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      clearAbortRef.current?.abort();
      returnAbortRef.current?.abort();
      returnInFlightRef.current = false;
      const abort = new AbortController();
      prepareAbortRef.current = abort;
      setPrepared({ kind: "Preparing" });
      setQuery("");
      setResult({ kind: "Idle" });
      setReturnAvailability(false);
      setDefect(null);
      setSelectedScopeId("");
      if (resetMatchOptions) {
        setMatchCase(false);
        setWholeWord(false);
      }
      void adapter
        .prepare({
          sessionId,
          sourceKey: adapter.sourceKey,
          signal: abort.signal,
        })
        .then((session) => {
          if (
            abort.signal.aborted ||
            sessionIdRef.current !== sessionId ||
            session.sessionId !== sessionId ||
            session.sourceKey !== adapter.sourceKey
          ) {
            return;
          }
          const entire = entireResourceScope(session.scopes);
          setSelectedScopeId(entire.id);
          setPrepared({ kind: "Ready", session });
        })
        .catch(defectAsync);
    },
    [adapter, defectAsync, setReturnAvailability],
  );

  useEffect(() => {
    if (!adapter) {
      sessionIdRef.current += 1;
      queryIdRef.current += 1;
      previewGenerationRef.current += 1;
      previewInFlightRef.current = 0;
      reprepareAfterPreviewRef.current = false;
      if (queryTimerRef.current !== null) {
        window.clearTimeout(queryTimerRef.current);
        queryTimerRef.current = null;
      }
      prepareAbortRef.current?.abort();
      queryAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      clearAbortRef.current?.abort();
      returnAbortRef.current?.abort();
      returnInFlightRef.current = false;
      setPrepared({ kind: "Preparing" });
      setQuery("");
      setResult({ kind: "Idle" });
      setReturnAvailability(false);
      setDefect(null);
      setSelectedScopeId("");
      setMatchCase(false);
      setWholeWord(false);
      return;
    }
    startPreparation({ resetMatchOptions: true });
    return () => {
      previewGenerationRef.current += 1;
      previewInFlightRef.current = 0;
      reprepareAfterPreviewRef.current = false;
      if (queryTimerRef.current !== null) {
        window.clearTimeout(queryTimerRef.current);
        queryTimerRef.current = null;
      }
      prepareAbortRef.current?.abort();
      queryAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      clearAbortRef.current?.abort();
      returnAbortRef.current?.abort();
    };
  }, [adapter, setReturnAvailability, startPreparation]);

  const onOpen = useCallback(() => {
    if (returnInFlightRef.current) return;
    if (returnAvailableRef.current) return;
    if (previewInFlightRef.current > 0) {
      reprepareAfterPreviewRef.current = true;
      return;
    }
    startPreparation({ resetMatchOptions: false });
  }, [startPreparation]);

  const retryRef = useRef<() => void>(() => {});
  const runQuery = useCallback(() => {
    if (!adapter || returnInFlightRef.current) return;
    const current = preparedRef.current;
    if (current.kind !== "Ready" || query.length === 0 || !selectedScopeId) {
      return;
    }
    clearCurrentPresentation();
    queryAbortRef.current?.abort();
    previewAbortRef.current?.abort();
    const abort = new AbortController();
    queryAbortRef.current = abort;
    const queryId = queryIdRef.current + 1;
    queryIdRef.current = queryId;
    const { session } = current;
    setResult({ kind: "Searching" });
    void adapter
      .find({
        sessionId: session.sessionId,
        queryId,
        sourceKey: session.sourceKey,
        signal: abort.signal,
        query,
        scopeId: selectedScopeId,
        matchCase,
        wholeWord,
      })
      .then((response) => {
        if (
          abort.signal.aborted ||
          sessionIdRef.current !== response.sessionId ||
          queryIdRef.current !== response.queryId ||
          response.sourceKey !== session.sourceKey
        ) {
          return;
        }
        switch (response.kind) {
          case "NoMatches":
            clearCurrentPresentation();
            setResult({
              kind: "NoMatches",
              completeness: response.completeness,
            });
            return;
          case "TooManyMatches":
            clearCurrentPresentation();
            setResult({
              kind: "TooManyMatches",
              threshold: response.threshold,
            });
            return;
          case "Failed":
            clearCurrentPresentation();
            setResult({
              kind: "Failed",
              message: adapter.errorMessage(response.error),
              onRetry: () => retryRef.current(),
            });
            return;
          case "Ready": {
            setResult(
              readyResult({
                rows: response.rows,
                activeKey: response.initialActiveKey,
                completeness: response.completeness,
              }),
            );
            const previewAbort = new AbortController();
            previewAbortRef.current = previewAbort;
            const previewGeneration = beginPreviewAttempt();
            void adapter
              .preview({
                sessionId: session.sessionId,
                queryId,
                sourceKey: session.sourceKey,
                signal: previewAbort.signal,
                key: response.initialActiveKey,
              })
              .then((receipt) => {
                const identifiesRequest =
                  receipt.sessionId === session.sessionId &&
                  receipt.queryId === queryId &&
                  receipt.sourceKey === session.sourceKey &&
                  receipt.key === response.initialActiveKey;
                const settlement = settlePreviewAttempt({
                  generation: previewGeneration,
                  capturedOrigin:
                    identifiesRequest && receipt.kind === "Previewed",
                });
                if (settlement.kind === "Current" && settlement.reprepare) {
                  startPreparation({ resetMatchOptions: false });
                }
                if (
                  settlement.kind === "Stale" ||
                  previewAbort.signal.aborted ||
                  sessionIdRef.current !== receipt.sessionId ||
                  queryIdRef.current !== receipt.queryId ||
                  receipt.sourceKey !== session.sourceKey ||
                  receipt.key !== response.initialActiveKey
                ) {
                  return;
                }
                if (receipt.kind === "Rejected") {
                  clearCurrentPresentation();
                  setResult({
                    kind: "Failed",
                    message: adapter.errorMessage(receipt.error),
                    onRetry: () => retryRef.current(),
                  });
                  return;
                }
              })
              .catch((error: unknown) => {
                const settlement = settlePreviewAttempt({
                  generation: previewGeneration,
                  capturedOrigin: false,
                });
                if (settlement.kind === "Current" && settlement.reprepare) {
                  startPreparation({ resetMatchOptions: false });
                }
                if (
                  settlement.kind === "Stale" ||
                  previewAbort.signal.aborted
                ) {
                  return;
                }
                defectAsync(error);
              });
            return;
          }
        }
      })
      .catch(defectAsync);
  }, [
    adapter,
    beginPreviewAttempt,
    clearCurrentPresentation,
    defectAsync,
    matchCase,
    query,
    selectedScopeId,
    settlePreviewAttempt,
    startPreparation,
    wholeWord,
  ]);
  retryRef.current = runQuery;

  useEffect(() => {
    if (query.length === 0) {
      if (queryTimerRef.current !== null) {
        window.clearTimeout(queryTimerRef.current);
        queryTimerRef.current = null;
      }
      queryAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      queryIdRef.current += 1;
      setResult({ kind: "Idle" });
      clearCurrentPresentation();
      return;
    }
    if (prepared.kind !== "Ready" || !selectedScopeId) return;
    const timeout = window.setTimeout(runQuery, PANE_FIND_INPUT_DELAY_MS);
    queryTimerRef.current = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (queryTimerRef.current === timeout) {
        queryTimerRef.current = null;
      }
    };
  }, [
    clearCurrentPresentation,
    prepared.kind,
    query,
    runQuery,
    selectedScopeId,
  ]);

  const retryPreviewRef = useRef<(attempt: PreviewAttempt) => Promise<boolean>>(
    async () => false,
  );
  const runPreview = useCallback(
    async (attempt: PreviewAttempt): Promise<boolean> => {
      if (!adapter || returnInFlightRef.current) return false;
      const currentSession = preparedRef.current;
      if (
        currentSession.kind !== "Ready" ||
        queryIdRef.current !== attempt.queryId ||
        !attempt.ready.rows.some((row) => row.key === attempt.key)
      ) {
        return false;
      }
      previewAbortRef.current?.abort();
      const abort = new AbortController();
      previewAbortRef.current = abort;
      const { session } = currentSession;
      const previewGeneration = beginPreviewAttempt();
      setResult(
        readyResult({
          rows: attempt.ready.rows,
          activeKey: attempt.key,
          completeness: attempt.ready.completeness,
        }),
      );
      try {
        const receipt = await adapter.preview({
          sessionId: session.sessionId,
          queryId: attempt.queryId,
          sourceKey: session.sourceKey,
          signal: abort.signal,
          key: attempt.key,
        });
        const identifiesRequest =
          receipt.sessionId === session.sessionId &&
          receipt.queryId === attempt.queryId &&
          receipt.sourceKey === session.sourceKey &&
          receipt.key === attempt.key;
        const settlement = settlePreviewAttempt({
          generation: previewGeneration,
          capturedOrigin: identifiesRequest && receipt.kind === "Previewed",
        });
        if (settlement.kind === "Current" && settlement.reprepare) {
          startPreparation({ resetMatchOptions: false });
        }
        if (
          settlement.kind === "Stale" ||
          abort.signal.aborted ||
          sessionIdRef.current !== receipt.sessionId ||
          queryIdRef.current !== receipt.queryId ||
          receipt.sourceKey !== session.sourceKey ||
          receipt.key !== attempt.key
        ) {
          return false;
        }
        if (receipt.kind === "Rejected") {
          clearCurrentPresentation();
          setResult({
            kind: "Failed",
            message: adapter.errorMessage(receipt.error),
            onRetry: () => {
              void retryPreviewRef.current(attempt);
            },
          });
          return false;
        }
        return true;
      } catch (error: unknown) {
        const settlement = settlePreviewAttempt({
          generation: previewGeneration,
          capturedOrigin: false,
        });
        if (settlement.kind === "Current" && settlement.reprepare) {
          startPreparation({ resetMatchOptions: false });
        }
        if (settlement.kind === "Stale" || abort.signal.aborted) {
          return false;
        }
        defectAsync(error);
        return false;
      }
    },
    [
      adapter,
      beginPreviewAttempt,
      clearCurrentPresentation,
      defectAsync,
      settlePreviewAttempt,
      startPreparation,
    ],
  );
  retryPreviewRef.current = runPreview;

  const preview = useCallback(
    async (key: PaneFindResultKey): Promise<boolean> => {
      const currentResult = resultRef.current;
      if (currentResult.kind !== "Ready") return false;
      return runPreview({
        key,
        queryId: queryIdRef.current,
        ready: currentResult,
      });
    },
    [runPreview],
  );

  const onStep = useCallback(
    (direction: "Previous" | "Next") => {
      const current = resultRef.current;
      if (current.kind !== "Ready") return;
      const index = current.rows.findIndex(
        (row) => row.key === current.activeKey,
      );
      const delta = direction === "Next" ? 1 : -1;
      const nextIndex =
        (index + delta + current.rows.length) % current.rows.length;
      const next = current.rows[nextIndex];
      if (next) void preview(next.key);
    },
    [preview],
  );

  const invalidateQuery = useCallback(() => {
    queryAbortRef.current?.abort();
    previewAbortRef.current?.abort();
    queryIdRef.current += 1;
    clearCurrentPresentation();
  }, [clearCurrentPresentation]);

  const onDismiss = useCallback(() => {
    if (returnInFlightRef.current) return;
    invalidateQuery();
    setQuery("");
    setResult({ kind: "Idle" });
  }, [invalidateQuery]);

  const onQueryChange = useCallback(
    (nextQuery: string) => {
      if (returnInFlightRef.current) return;
      invalidateQuery();
      const truncated = truncatePaneSearchQuery(nextQuery);
      setQuery(truncated);
      setResult(
        truncated.length === 0 ? { kind: "Idle" } : { kind: "Searching" },
      );
    },
    [invalidateQuery],
  );

  const onMatchCaseChange = useCallback(
    (value: boolean) => {
      if (returnInFlightRef.current) return;
      invalidateQuery();
      setMatchCase(value);
      if (query.length > 0) setResult({ kind: "Searching" });
    },
    [invalidateQuery, query.length],
  );

  const onWholeWordChange = useCallback(
    (value: boolean) => {
      if (returnInFlightRef.current) return;
      invalidateQuery();
      setWholeWord(value);
      if (query.length > 0) setResult({ kind: "Searching" });
    },
    [invalidateQuery, query.length],
  );

  const onScopeChange = useCallback(
    (scopeId: string) => {
      if (returnInFlightRef.current) return;
      const current = preparedRef.current;
      if (
        current.kind !== "Ready" ||
        !current.session.scopes.some((scope) => scope.id === scopeId)
      ) {
        throw new Error(`Unknown Pane Find scope: ${scopeId}`);
      }
      invalidateQuery();
      setSelectedScopeId(scopeId);
      if (query.length > 0) setResult({ kind: "Searching" });
    },
    [invalidateQuery, query.length],
  );

  const onReturn = useCallback(() => {
    const current = preparedRef.current;
    if (
      !adapter ||
      current.kind !== "Ready" ||
      !returnAvailable ||
      returnInFlightRef.current
    ) {
      return;
    }
    returnInFlightRef.current = true;
    if (queryTimerRef.current !== null) {
      window.clearTimeout(queryTimerRef.current);
      queryTimerRef.current = null;
    }
    previewGenerationRef.current += 1;
    previewInFlightRef.current = 0;
    reprepareAfterPreviewRef.current = false;
    queryAbortRef.current?.abort();
    previewAbortRef.current?.abort();
    clearAbortRef.current?.abort();
    returnAbortRef.current?.abort();
    const abort = new AbortController();
    returnAbortRef.current = abort;
    const { session } = current;
    void adapter
      .returnToReadingPosition({
        sessionId: session.sessionId,
        sourceKey: session.sourceKey,
        signal: abort.signal,
      })
      .then(() => {
        if (
          abort.signal.aborted ||
          sessionIdRef.current !== session.sessionId ||
          preparedRef.current.kind !== "Ready" ||
          preparedRef.current.session.sourceKey !== session.sourceKey
        ) {
          return;
        }
        setReturnAvailability(false);
      })
      .catch(defectAsync)
      .finally(() => {
        if (returnAbortRef.current === abort) {
          returnInFlightRef.current = false;
        }
      });
  }, [adapter, defectAsync, returnAvailable, setReturnAvailability]);

  const scope = useMemo<PaneFindScopeControl>(() => {
    if (prepared.kind !== "Ready" || prepared.session.scopes.length <= 1) {
      return { kind: "EntireResource" };
    }
    return {
      kind: "Selectable",
      selectedId: selectedScopeId,
      options: prepared.session.scopes,
      onChange: onScopeChange,
    };
  }, [onScopeChange, prepared, selectedScopeId]);

  const returnToReadingPosition = useMemo<
    PaneFindController["returnToReadingPosition"]
  >(
    () =>
      returnAvailable
        ? { kind: "Available", onReturn }
        : { kind: "Unavailable" },
    [onReturn, returnAvailable],
  );

  const controller = useMemo<PaneFindController>(
    () => ({
      query,
      result,
      scope,
      matchCase,
      wholeWord,
      returnToReadingPosition,
      onOpen,
      onQueryChange,
      onDismiss,
      onMatchCaseChange,
      onWholeWordChange,
      onStep,
      onActivate: preview,
    }),
    [
      matchCase,
      onDismiss,
      onMatchCaseChange,
      onOpen,
      onQueryChange,
      onStep,
      onWholeWordChange,
      preview,
      query,
      result,
      returnToReadingPosition,
      scope,
      wholeWord,
    ],
  );
  const useResult = useMemo<PaneFindUseResult>(
    () =>
      adapter ? { kind: "Available", controller } : { kind: "Unavailable" },
    [adapter, controller],
  );

  if (defect !== null) throw defect;
  return useResult;
}
