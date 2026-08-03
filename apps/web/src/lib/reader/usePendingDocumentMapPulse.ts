"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ReaderPulseTarget } from "./pulseEvent";

export interface PendingDocumentMapPulse {
  fragmentId: string;
  target: ReaderPulseTarget;
  apparatusStableKey?: string;
}

interface PendingDocumentMapPulseOptions {
  activeFragmentId: string | null;
  loading: boolean;
  renderedContentKey: string;
  focusApparatus: (stableKey: string, shouldScroll: boolean) => void;
  scrollHighlight: (
    highlightId: string,
    afterPosition: () => void,
  ) => () => void;
  dispatchPulse: (target: ReaderPulseTarget) => void;
}

/**
 * Owns a Document Map activation while its destination fragment is rendering.
 * Effect cleanup may cancel positioning, so ownership is released only after
 * the matching activation actually completes.
 */
export function usePendingDocumentMapPulse({
  activeFragmentId,
  loading,
  renderedContentKey,
  focusApparatus,
  scrollHighlight,
  dispatchPulse,
}: PendingDocumentMapPulseOptions): (
  pending: PendingDocumentMapPulse,
) => void {
  const pendingRef = useRef<PendingDocumentMapPulse | null>(null);

  const queue = useCallback((pending: PendingDocumentMapPulse) => {
    pendingRef.current = pending;
  }, []);

  useEffect(() => {
    const pending = pendingRef.current;
    if (
      !pending ||
      loading ||
      activeFragmentId !== pending.fragmentId
    ) {
      return;
    }
    if (pending.apparatusStableKey) {
      pendingRef.current = null;
      focusApparatus(pending.apparatusStableKey, true);
      dispatchPulse(pending.target);
      return;
    }
    if (pending.target.highlightId) {
      return scrollHighlight(pending.target.highlightId, () => {
        if (pendingRef.current !== pending) return;
        pendingRef.current = null;
        dispatchPulse(pending.target);
      });
    }
    const frame = window.requestAnimationFrame(() => {
      if (pendingRef.current !== pending) return;
      pendingRef.current = null;
      dispatchPulse(pending.target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeFragmentId,
    dispatchPulse,
    focusApparatus,
    loading,
    renderedContentKey,
    scrollHighlight,
  ]);

  return queue;
}
