"use client";

import { useEffect, useRef, type RefObject } from "react";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";

/**
 * When `active` (and again whenever `key` changes), focus — on the next frame —
 * `select(container)` if provided and found, else the first focusable element,
 * else the container itself. The rAF defers focus until after the overlay paints.
 * `select` is read through a ref so an inline selector does not retrigger the effect.
 */
export function useInitialFocus(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options?: { select?: (container: HTMLElement) => HTMLElement | null; key?: unknown },
): void {
  const selectRef = useRef(options?.select);
  selectRef.current = options?.select;
  const key = options?.key;

  useEffect(() => {
    if (!active || !containerRef.current) return;
    const container = containerRef.current;
    const frame = window.requestAnimationFrame(() => {
      const target =
        selectRef.current?.(container) ?? getFocusableElements(container)[0] ?? container;
      target.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, key, containerRef]);
}
