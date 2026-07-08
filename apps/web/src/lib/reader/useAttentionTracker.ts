"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { readDeviceId } from "@/lib/attention";

// Only one tracker per media id may accumulate dwell within a tab: document
// .hasFocus() is window-scoped and cannot tell two visible split panes apart, so
// the first mount wins and later mounts for the same media id are no-ops (D-2).
const _ACTIVE_DWELL_TRACKERS = new Set<string>();
// Cap a single rAF delta so one stalled frame cannot inflate dwell (R-3).
const MAX_FRAME_DELTA_MS = 500;

export interface AttentionTracker {
  /** Accumulated dwell (ms) since the last flush; folded into the save payload. */
  dwellDeltaRef: RefObject<number>;
  /** Zero the delta after a flush. */
  resetDelta: () => void;
  /** Opaque originating device id for the ledger. */
  deviceId: string;
}

/**
 * Accumulate reading dwell for one media id via requestAnimationFrame, gated on
 * `document.visibilityState === "visible" && document.hasFocus()`. Dwell accrues
 * only while both hold; hiding the tab or blurring the window pauses it.
 */
export function useAttentionTracker(options: { mediaId: string | null }): AttentionTracker {
  const { mediaId } = options;
  const dwellDeltaRef = useRef(0);
  const [deviceId] = useState(() => readDeviceId());

  useEffect(() => {
    if (!mediaId) return;
    // Singleton lock: a second tracker for the same media id never accumulates.
    if (_ACTIVE_DWELL_TRACKERS.has(mediaId)) return;
    _ACTIVE_DWELL_TRACKERS.add(mediaId);

    let rafId = 0;
    let lastTimestamp: number | null = null;
    const tick = (timestamp: number) => {
      const active =
        document.visibilityState === "visible" && document.hasFocus();
      if (active && lastTimestamp !== null) {
        dwellDeltaRef.current += Math.max(
          0,
          Math.min(timestamp - lastTimestamp, MAX_FRAME_DELTA_MS),
        );
      }
      // Drop the anchor while inactive so the resume frame does not count the gap.
      lastTimestamp = active ? timestamp : null;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      _ACTIVE_DWELL_TRACKERS.delete(mediaId);
    };
  }, [mediaId]);

  const resetDelta = useCallback(() => {
    dwellDeltaRef.current = 0;
  }, []);

  return { dwellDeltaRef, resetDelta, deviceId };
}
