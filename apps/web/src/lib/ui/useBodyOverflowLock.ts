"use client";

import { useEffect, useRef } from "react";

const owners = new Set<object>();
let priorOverflow = "";

/**
 * When `active` is true, set `document.body.style.overflow = "hidden"` and
 * restore the prior value after the final active owner releases its lock.
 *
 * Use this to prevent background scrolling while a full-screen modal, tray,
 * or sheet is open. A module-wide owner set makes nesting and non-LIFO closes
 * safe: only the zero-to-one and one-to-zero transitions touch body styles.
 */
export function useBodyOverflowLock(active: boolean): void {
  const token = useEffectToken();
  useEffect(() => {
    if (!active) return;
    if (owners.size === 0) {
      priorOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    owners.add(token);
    return () => {
      if (!owners.delete(token)) {
        throw new Error("Active body-overflow lock was not registered.");
      }
      if (owners.size === 0) {
        document.body.style.overflow = priorOverflow;
        priorOverflow = "";
      }
    };
  }, [active, token]);
}

function useEffectToken(): object {
  const tokenRef = useRef<object | null>(null);
  if (tokenRef.current === null) tokenRef.current = {};
  return tokenRef.current;
}
