"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export type ReturnFocusTarget = () => HTMLElement | null;

export interface ReturnFocusOptions {
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly skip?: () => boolean;
}

export interface ReturnFocusHandle {
  /**
   * Re-run the captured return-focus decision after an owning platform
   * lifecycle (for example, a same-document history traversal) has settled.
   */
  readonly restore: () => void;
}

function focusTarget(target: HTMLElement | null): boolean {
  if (!target?.isConnected) return false;
  const focusAfterBrowserSettlement = () => {
    requestAnimationFrame(() => {
      if (!target.isConnected || target.closest("[inert]")) return;
      if (
        document.activeElement === document.body ||
        document.activeElement === document.documentElement
      ) {
        target.focus();
      }
    });
  };
  if (!target.closest("[inert]")) {
    target.focus();
    focusAfterBrowserSettlement();
    return true;
  }
  requestAnimationFrame(() => {
    if (target.isConnected && !target.closest("[inert]")) {
      target.focus();
      focusAfterBrowserSettlement();
    }
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
export function useReturnFocus(
  active: boolean,
  options?: ReturnFocusOptions,
): ReturnFocusHandle {
  const returnFocusToRef = useRef(options?.returnFocusTo);
  returnFocusToRef.current = options?.returnFocusTo;
  const fallbackRef = useRef(options?.returnFocusFallback);
  fallbackRef.current = options?.returnFocusFallback;
  const skipRef = useRef(options?.skip);
  skipRef.current = options?.skip;
  const returnRef = useRef<HTMLElement | null>(null);
  const restore = useCallback(() => {
    if (skipRef.current?.()) return;
    const liveTarget = returnFocusToRef.current?.() ?? null;
    if (focusTarget(liveTarget)) return;
    const target = returnRef.current;
    if (focusTarget(target)) return;
    const fallback = fallbackRef.current?.() ?? null;
    focusTarget(fallback);
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    const explicitTarget = returnFocusToRef.current?.() ?? null;
    const activeElement =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      document.activeElement.isConnected
        ? document.activeElement
        : null;
    returnRef.current = explicitTarget ?? activeElement;
  }, [active]);

  useEffect(() => {
    if (!active) return;
    return restore;
  }, [active, restore]);

  return { restore };
}
