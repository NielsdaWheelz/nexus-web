"use client";

import { useCallback, useRef } from "react";

export default function usePaneCollectionInput() {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInput = useCallback((): boolean => {
    const input = inputRef.current;
    if (
      !input?.isConnected ||
      input.disabled ||
      input.closest("[inert]") ||
      input.closest('[aria-hidden="true"]') ||
      input.getClientRects().length === 0 ||
      window.getComputedStyle(input).visibility !== "visible"
    ) {
      return false;
    }
    const scrollport = input.closest<HTMLElement>("[data-pane-content='true']");
    if (!scrollport) return false;
    scrollport.scrollTop = 0;
    input.focus({ preventScroll: true });
    if (document.activeElement !== input) return false;
    input.select();
    return true;
  }, []);
  return { inputRef, focusInput };
}
