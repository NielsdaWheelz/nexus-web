"use client";

import { useCallback } from "react";

import { useStringIdSet } from "@/lib/useStringIdSet";

/**
 * Owns the "busy id set" add/await/finally-remove dance for per-item optimistic
 * actions. Wraps {@link useStringIdSet}, keeping the busy set internal so callers
 * only see `isBusy`/`runWithBusy`. `runWithBusy` dedupes back-to-back invocations
 * for the same id and always clears busy state, even when `action` rejects.
 */
export function useOptimisticAction(): {
  isBusy: (id: string) => boolean;
  runWithBusy: (id: string, action: () => Promise<void>) => Promise<void>;
} {
  const busy = useStringIdSet();

  const isBusy = useCallback((id: string) => busy.has(id), [busy]);

  const runWithBusy = useCallback(
    async (id: string, action: () => Promise<void>) => {
      if (busy.has(id)) return;
      busy.add(id);
      try {
        await action();
      } finally {
        busy.remove(id);
      }
    },
    [busy],
  );

  return { isBusy, runWithBusy };
}
