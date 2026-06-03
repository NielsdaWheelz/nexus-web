"use client";

import { useEffect, useRef } from "react";
import { isRecord } from "@/lib/validation";

/**
 * While `active`, push one synthetic history entry so the Android/browser back
 * button dismisses the overlay (fires `onDismiss`) instead of leaving the page.
 * When `active` goes false because the overlay closed via its own UI, the entry
 * we pushed is popped automatically; the back-button path already consumed it, so
 * it is never popped twice (C7). Keep this hook mounted across the overlay's
 * open/close (don't unmount it with the overlay) — it stays strict-mode safe and
 * covers every close path, since it reacts to `active` rather than to unmount.
 */

const MARKER = "__nexusOverlayHistory";

function hasMarker(): boolean {
  return isRecord(history.state) && history.state[MARKER] === true;
}

export function useHistoryDismiss(active: boolean, onDismiss: () => void): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const entryActiveRef = useRef(false);

  useEffect(() => {
    if (!active) {
      if (entryActiveRef.current) {
        // Closed via the overlay's own UI — remove the entry we pushed. The
        // popstate this triggers has no listener (the open-effect cleanup ran
        // first), so it cannot re-fire onDismiss.
        entryActiveRef.current = false;
        history.back();
      }
      return;
    }
    if (!hasMarker()) {
      history.pushState({ ...(isRecord(history.state) ? history.state : {}), [MARKER]: true }, "");
    }
    entryActiveRef.current = true;
    const onPopState = () => {
      // Back button: the browser already removed our entry; just dismiss.
      entryActiveRef.current = false;
      onDismissRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [active]);
}
