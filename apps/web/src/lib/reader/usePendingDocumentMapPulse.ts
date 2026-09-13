"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReaderPulseTarget } from "./pulseEvent";

export interface PendingDocumentMapPulse {
  fragmentId: string;
  target: ReaderPulseTarget;
  apparatusStableKey?: string;
  isCurrent: () => boolean;
  onArrive: () => void;
}

// Canonical restore owns positioning. This owner releases decoration only once
// its exact source target is visible in the current committed fragment.
export function usePendingDocumentMapPulse({
  activeFragmentId,
  loading,
  renderedContentKey,
  isTargetVisible,
  focusApparatus,
  dispatchPulse,
}: {
  activeFragmentId: string | null;
  loading: boolean;
  renderedContentKey: string;
  isTargetVisible: (target: ReaderPulseTarget) => boolean;
  focusApparatus: (stableKey: string, shouldScroll: boolean) => void;
  dispatchPulse: (target: ReaderPulseTarget) => void;
}): (pending: PendingDocumentMapPulse | null) => void {
  const [pending, setPending] = useState<PendingDocumentMapPulse | null>(null);
  const queue = useCallback((next: PendingDocumentMapPulse | null) => setPending(next), []);
  useEffect(() => {
    if (!pending || loading || activeFragmentId !== pending.fragmentId ||
        !pending.isCurrent() || !isTargetVisible(pending.target)) return;
    if (pending.apparatusStableKey) focusApparatus(pending.apparatusStableKey, false);
    dispatchPulse(pending.target);
    pending.onArrive();
    setPending(null);
  }, [activeFragmentId, dispatchPulse, focusApparatus, isTargetVisible, loading, pending, renderedContentKey]);
  return queue;
}
