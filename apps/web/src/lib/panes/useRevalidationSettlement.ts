"use client";

import { useEffect, useMemo, useRef } from "react";

interface Pending {
  readonly requestId: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

const abortError = (message: string) => new DOMException(message, "AbortError");

/**
 * One refresh waiter: a pane's refresh waits on it, and the pane resolves it
 * when its revalidated data commits. A new wait supersedes the old one.
 */
export function useRevalidationSettlement() {
  const pending = useRef<Pending | null>(null);
  const settlement = useMemo(() => {
    // the waiter, if it is `requestId`'s (or any, without one), now detached.
    const take = (requestId?: number): Pending | null => {
      const current = pending.current;
      if (
        !current ||
        (requestId !== undefined && current.requestId !== requestId)
      )
        return null;
      pending.current = null;
      current.signal.removeEventListener("abort", current.abort);
      return current;
    };
    const reject = (error: unknown) => take()?.reject(error);
    return {
      isPending: (requestId: number) =>
        pending.current?.requestId === requestId,
      resolve: (requestId: number) => take(requestId)?.resolve(),
      reject,
      wait(input: {
        readonly requestId: number;
        readonly signal: AbortSignal;
        readonly onAbort: () => void;
      }): Promise<void> {
        reject(abortError("Pane refresh was superseded."));
        const { requestId, signal } = input;
        return new Promise<void>((resolve, rejectWait) => {
          const abort = () => {
            if (!take(requestId)) return;
            input.onAbort();
            rejectWait(
              signal.reason ?? abortError("Pane refresh was aborted."),
            );
          };
          pending.current = {
            requestId,
            resolve,
            reject: rejectWait,
            signal,
            abort,
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    };
  }, []);
  useEffect(
    () => () => settlement.reject(abortError("Pane refresh was unmounted.")),
    [settlement],
  );
  return settlement;
}
