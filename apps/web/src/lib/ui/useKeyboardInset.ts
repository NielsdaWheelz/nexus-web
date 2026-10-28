"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { readNativeKeyboardVisibility, subscribeNativeKeyboardVisibility } from "@/lib/native/client";

// The iOS keyboard shim. Android and Firefox resize the layout viewport
// (interactive-widget=resizes-content), so the bottom inset reads ~0 there.
// Insets under 60px read 0: browser-chrome noise and the iOS 26.0 stale
// visualViewport residue (WebKit 297779) must not float a surface above the
// bottom edge. The top is the raw nonnegative visual-viewport offset: a
// full-screen task follows the iOS viewport pan even with no keyboard.
const THRESHOLD_PX = 60;
const ZERO = { keyboardBottomInsetPx: 0, visualViewportTopPx: 0 };
// Snapshot reads never measure layout. Subscription and native viewport events
// refresh the cache; every subscriber hears a changed shared snapshot, including
// when another subscriber refreshes it while the keyboard is already open.
let last = ZERO;
const listeners = new Set<() => void>();

function read(): typeof ZERO {
  return last;
}

function refresh(): void {
  const viewport = window.visualViewport;
  let next = ZERO;
  if (viewport) {
    const top = Number.isFinite(viewport.offsetTop)
      ? Math.max(0, viewport.offsetTop)
      : 0;
    const measured = Math.max(0, window.innerHeight - viewport.height - top);
    const bottom = measured < THRESHOLD_PX ? 0 : measured;
    next = { keyboardBottomInsetPx: bottom, visualViewportTopPx: top };
  }
  if (
    last.keyboardBottomInsetPx === next.keyboardBottomInsetPx &&
    last.visualViewportTopPx === next.visualViewportTopPx
  ) return;
  last = next;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  const onGeometry = () => refresh();
  listeners.add(onChange);
  window.addEventListener("resize", onGeometry);
  viewport?.addEventListener("resize", onGeometry);
  viewport?.addEventListener("scroll", onGeometry);
  refresh();
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("resize", onGeometry);
    viewport?.removeEventListener("resize", onGeometry);
    viewport?.removeEventListener("scroll", onGeometry);
  };
}

export function useKeyboardInset(): typeof ZERO {
  return useSyncExternalStore(subscribe, read, () => ZERO);
}

/** Exact installed-app signal; browsers retain null instead of guessing from an inset. */
export function useNativeKeyboardVisibility(): boolean | null {
  return useSyncExternalStore(subscribeNativeKeyboardVisibility, readNativeKeyboardVisibility, () => null);
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
