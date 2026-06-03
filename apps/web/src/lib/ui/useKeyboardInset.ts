"use client";

import { useSyncExternalStore } from "react";

/**
 * The pixels the on-screen keyboard (and bottom browser chrome) cover at the
 * bottom of the layout viewport, from `visualViewport`. A pinned-to-bottom
 * surface offsets itself by this much to stay above the keyboard (E-4 / C6).
 * SSR/no-viewport → 0.
 */

function readInset(): number {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (!viewport) return 0;
  return Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
}

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  window.addEventListener("resize", onChange);
  viewport?.addEventListener("resize", onChange);
  viewport?.addEventListener("scroll", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    viewport?.removeEventListener("resize", onChange);
    viewport?.removeEventListener("scroll", onChange);
  };
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, readInset, () => 0);
}
