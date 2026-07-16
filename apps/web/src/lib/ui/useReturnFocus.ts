"use client";

import { useEffect, useRef } from "react";

/**
 * While `active`, remember the element focused at activation and restore focus to
 * it when `active` flips false / on unmount. If that element is gone
 * (`!isConnected`), focus `fallback()` instead (e.g. the pane chrome that replaced
 * the trigger).
 *
 * `options.skip`, read at restore time, opts a single close out of the restore: a
 * navigating dispatch focuses its destination, so restoring the opener here would
 * yank focus back and fight it. Dismissal paths (Escape, backdrop) leave `skip`
 * unset and keep the return-focus contract unchanged.
 */
export function useReturnFocus(
  active: boolean,
  fallback?: () => HTMLElement | null,
  options?: { skip?: () => boolean },
): void {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const skipRef = useRef(options?.skip);
  skipRef.current = options?.skip;
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    returnRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (skipRef.current?.()) return;
      const target = returnRef.current;
      if (target?.isConnected) {
        target.focus();
        return;
      }
      fallbackRef.current?.()?.focus();
    };
  }, [active]);
}
