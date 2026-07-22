"use client";

import { useEffect, useRef } from "react";

export type ReturnFocusTarget = () => HTMLElement | null;

export interface ReturnFocusOptions {
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly skip?: () => boolean;
}

function focusTarget(target: HTMLElement | null): boolean {
  if (!target?.isConnected) return false;
  if (!target.closest("[inert]")) {
    target.focus();
    return true;
  }
  requestAnimationFrame(() => {
    if (target.isConnected && !target.closest("[inert]")) target.focus();
  });
  return true;
}

/**
 * While `active`, capture an explicit return target or the ambient focused
 * element, then restore it when `active` flips false / on unmount. If that
 * element is gone, focus the fallback instead.
 *
 * `options.skip`, read at restore time, opts a single close out of the restore: a
 * navigating dispatch focuses its destination, so restoring the opener here would
 * yank focus back and fight it. Dismissal paths (Escape, backdrop) leave `skip`
 * unset and keep the return-focus contract unchanged.
 */
export function useReturnFocus(active: boolean, options?: ReturnFocusOptions): void {
  const returnFocusToRef = useRef(options?.returnFocusTo);
  returnFocusToRef.current = options?.returnFocusTo;
  const fallbackRef = useRef(options?.returnFocusFallback);
  fallbackRef.current = options?.returnFocusFallback;
  const skipRef = useRef(options?.skip);
  skipRef.current = options?.skip;
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const explicitTarget = returnFocusToRef.current?.() ?? null;
    const activeElement =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      document.activeElement.isConnected
        ? document.activeElement
        : null;
    returnRef.current = explicitTarget ?? activeElement;
    return () => {
      if (skipRef.current?.()) return;
      const target = returnRef.current;
      if (focusTarget(target)) return;
      const fallback = fallbackRef.current?.() ?? null;
      focusTarget(fallback);
    };
  }, [active]);
}
