"use client";

import { useEffect, useRef } from "react";

/**
 * While `active`, call `onEscape` when the user presses Escape (captured at the
 * document level, with preventDefault). The handler is read through a ref so the
 * listener attaches once per activation and the caller need not memoise it.
 */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEscapeRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active]);
}
