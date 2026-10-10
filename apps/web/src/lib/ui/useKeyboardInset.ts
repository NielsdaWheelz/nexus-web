"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { useMobileViewport } from "@/lib/mobileShell/viewport";

// The iOS keyboard shim. Android and Firefox resize the layout viewport
// (interactive-widget=resizes-content), so the bottom inset reads ~0 there.
// Insets under 60px read 0: browser-chrome noise and the iOS 26.0 stale
// visualViewport residue (WebKit 297779) must not float a surface above the
// bottom edge. The top is the raw nonnegative visual-viewport offset: a
// full-screen task follows the iOS viewport pan even with no keyboard.
const THRESHOLD_PX = 60;
const ZERO = { keyboardBottomInsetPx: 0, visualViewportTopPx: 0 };
let last = ZERO;

function read(): typeof ZERO {
  const viewport = window.visualViewport;
  if (!viewport) return ZERO;
  const top = Number.isFinite(viewport.offsetTop)
    ? Math.max(0, viewport.offsetTop)
    : 0;
  const measured = Math.max(0, window.innerHeight - viewport.height - top);
  const bottom = measured < THRESHOLD_PX ? 0 : measured;
  if (
    last.keyboardBottomInsetPx !== bottom ||
    last.visualViewportTopPx !== top
  ) {
    last = { keyboardBottomInsetPx: bottom, visualViewportTopPx: top };
  }
  return last;
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

export function useKeyboardInset(): typeof ZERO {
  return useSyncExternalStore(subscribe, read, () => ZERO);
}

/** While active, the newest report owns --mobile-overlay-keyboard-inset. */
export function useKeyboardReport(active: boolean): void {
  const { keyboardBottomInsetPx } = useKeyboardInset();
  const viewport = useMobileViewport();
  useLayoutEffect(() => {
    if (!active) return;
    return viewport.reportMobileOverlayKeyboardInset(keyboardBottomInsetPx);
  }, [active, keyboardBottomInsetPx, viewport]);
}
