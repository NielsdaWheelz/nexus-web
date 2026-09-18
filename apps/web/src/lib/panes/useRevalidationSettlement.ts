"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

interface PendingRevalidation {
  readonly requestId: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

/** Owns one refresh waiter. The pane decides when its data has committed. */
export function useRevalidationSettlement() {
  const pendingRef = useRef<PendingRevalidation | null>(null);
  const reject = useCallback((error: unknown) => {
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    pending.removeAbortListener();
    pending.reject(error);
  }, []);
  const isPending = useCallback(
    (requestId: number) => pendingRef.current?.requestId === requestId,
    [],
  );
  const resolve = useCallback((requestId: number) => {
    const pending = pendingRef.current;
    if (pending?.requestId !== requestId) return;
    pendingRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, []);
  const wait = useCallback(
    ({ requestId, signal, onAbort }: {
      requestId: number;
      signal: AbortSignal;
      onAbort: () => void;
    }): Promise<void> => {
      reject(new DOMException("Pane refresh was superseded.", "AbortError"));
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          if (pendingRef.current?.requestId !== requestId) return;
          pendingRef.current = null;
          signal.removeEventListener("abort", abort);
          onAbort();
          reject(
            signal.reason ??
              new DOMException("Pane refresh was aborted.", "AbortError"),
          );
        };
        pendingRef.current = {
          requestId,
          resolve,
          reject,
          removeAbortListener: () => signal.removeEventListener("abort", abort),
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    [reject],
  );
  useEffect(
    () => () => {
      reject(new DOMException("Pane refresh was unmounted.", "AbortError"));
    },
    [reject],
  );
  return useMemo(
    () => ({ wait, isPending, resolve, reject }),
    [wait, isPending, resolve, reject],
  );
}
