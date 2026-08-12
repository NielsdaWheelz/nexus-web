"use client";

import { useCallback, useEffect, useRef } from "react";
import { useOptionalMobileChromeVisibleLocks } from "./mobileChrome";

/**
 * Pins mobile chrome while an ActionMenu-backed overlay is open. The lock stays
 * owned by MobileChromeProvider; menu surfaces only acquire and release it.
 */
export function useMobileChromeActionMenuLock(): {
  readonly onOpenChange: (open: boolean) => void;
} {
  const { acquire } = useOptionalMobileChromeVisibleLocks();
  const releaseRef = useRef<(() => void) | null>(null);

  const release = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        release();
        return;
      }
      if (releaseRef.current) return;
      releaseRef.current = acquire("action-menu");
    },
    [acquire, release],
  );

  useEffect(() => release, [release]);

  return { onOpenChange };
}
