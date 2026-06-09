"use client";

import { useSyncExternalStore } from "react";

/**
 * The pixels the on-screen keyboard covers at the bottom of the layout
 * viewport, from `visualViewport`. This is the iOS keyboard shim: Android and
 * Firefox resize the layout viewport via `interactive-widget=resizes-content`,
 * so the measured inset is ~0 there and only iOS Safari carries a real value.
 * A pinned-to-bottom surface offsets itself by this much to stay above the
 * keyboard (E-4 / C6). SSR/no-viewport → 0.
 *
 * Values below the threshold report 0: browser-chrome geometry noise and the
 * iOS 26.0 stale-`visualViewport` regression (~24 px residue after keyboard
 * close, WebKit bug 297779) must not leave sheets floating above the bottom
 * edge. 60 px is below any real keyboard and above observed noise.
 */
export const KEYBOARD_INSET_THRESHOLD_PX = 60;

function readInset(): number {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (!viewport) return 0;
  const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  return inset < KEYBOARD_INSET_THRESHOLD_PX ? 0 : inset;
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
