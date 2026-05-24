"use client";

import { useEffect } from "react";

/**
 * When `active` is true, set `document.body.style.overflow = "hidden"` and
 * restore the prior value on cleanup or when `active` flips back to false.
 *
 * Use this to prevent background scrolling while a full-screen modal, tray,
 * or sheet is open. The previous overflow value is captured per activation
 * so nested locks compose correctly.
 */
export function useBodyOverflowLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}
