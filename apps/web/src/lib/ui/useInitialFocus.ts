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
  options?: {
    enabled?: boolean;
    select?: (container: HTMLElement) => HTMLElement | null;
    key?: unknown;
  },
): void {
  const selectRef = useRef(options?.select);
  selectRef.current = options?.select;
  const enabled = options?.enabled ?? true;
  const key = options?.key;
  const focusedRef = useRef(false);
  const focusedKeyRef = useRef(key);

  useEffect(() => {
    if (!active) {
      focusedRef.current = false;
      focusedKeyRef.current = key;
      return;
    }
    if (!enabled || !containerRef.current) return;
    if (focusedRef.current && Object.is(focusedKeyRef.current, key)) return;
    const container = containerRef.current;
    focusedRef.current = true;
    focusedKeyRef.current = key;
    const frame = window.requestAnimationFrame(() => {
      const target =
        selectRef.current?.(container) ?? getFocusableElements(container)[0] ?? container;
      target.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, enabled, key, containerRef]);
}
