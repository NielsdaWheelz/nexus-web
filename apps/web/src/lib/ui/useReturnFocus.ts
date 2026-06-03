"use client";

import { useEffect, useRef } from "react";

/**
 * While `active`, remember the element focused at activation and restore focus to
 * it when `active` flips false / on unmount. If that element is gone
 * (`!isConnected`), focus `fallback()` instead (e.g. the pane chrome that replaced
 * the trigger).
 */
export function useReturnFocus(
  active: boolean,
  fallback?: () => HTMLElement | null,
): void {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    returnRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = returnRef.current;
      if (target?.isConnected) {
        target.focus();
        return;
      }
      fallbackRef.current?.()?.focus();
    };
  }, [active]);
}
