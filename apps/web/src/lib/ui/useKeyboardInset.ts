"use client";

import { useSyncExternalStore } from "react";

/**
 * The visual-viewport geometry a mobile modal needs while the on-screen
 * keyboard is open. This is the iOS keyboard shim: Android and Firefox resize
 * the layout viewport via `interactive-widget=resizes-content`, so the
 * measured bottom inset is ~0 there and only iOS Safari carries a real value.
 *
 * Bottom values below the threshold report 0: browser-chrome geometry noise
 * and the iOS 26.0 stale-`visualViewport` regression (~24 px residue after
 * keyboard close, WebKit bug 297779) must not leave modal surfaces floating
 * above the bottom edge. The raw nonnegative top offset is deliberately not
 * thresholded: full-screen tasks need iOS viewport-pan compensation even when
 * no keyboard bottom inset is present. SSR/no-viewport → {0, 0}.
 */
export const KEYBOARD_INSET_THRESHOLD_PX = 60;

export interface KeyboardViewportGeometry {
  readonly keyboardBottomInsetPx: number;
  readonly visualViewportTopPx: number;
}

const ZERO_GEOMETRY: KeyboardViewportGeometry = {
  keyboardBottomInsetPx: 0,
  visualViewportTopPx: 0,
};
let lastGeometry = ZERO_GEOMETRY;

function readGeometry(): KeyboardViewportGeometry {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (!viewport) return ZERO_GEOMETRY;

  const visualViewportTopPx =
    Number.isFinite(viewport.offsetTop) && viewport.offsetTop >= 0
      ? viewport.offsetTop
      : 0;
  const measuredBottomInsetPx = Math.max(
    0,
    window.innerHeight - viewport.height - visualViewportTopPx,
  );
  const keyboardBottomInsetPx =
    measuredBottomInsetPx < KEYBOARD_INSET_THRESHOLD_PX
      ? 0
      : measuredBottomInsetPx;

  if (
    lastGeometry.keyboardBottomInsetPx === keyboardBottomInsetPx &&
    lastGeometry.visualViewportTopPx === visualViewportTopPx
  ) {
    return lastGeometry;
  }
  lastGeometry = { keyboardBottomInsetPx, visualViewportTopPx };
  return lastGeometry;
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

export function useKeyboardInset(): KeyboardViewportGeometry {
  return useSyncExternalStore(subscribe, readGeometry, () => ZERO_GEOMETRY);
}
