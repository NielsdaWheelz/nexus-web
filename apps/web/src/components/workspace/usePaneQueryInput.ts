"use client";

import { useCallback, useRef } from "react";

/** Focus the stationary query field without moving its content scrollport. */
export function usePaneQueryInput() {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInput = useCallback((): boolean => {
    const input = inputRef.current;
    if (
      !input?.isConnected || input.disabled ||
      input.closest("[inert], [aria-hidden='true']") ||
      input.getClientRects().length === 0 ||
      getComputedStyle(input).visibility !== "visible"
    ) return false;
    input.focus({ preventScroll: true });
    if (document.activeElement !== input) return false;
    input.select();
    return true;
  }, []);
  return { inputRef, focusInput };
}
