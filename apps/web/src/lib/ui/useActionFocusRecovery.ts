"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A focused shortcut that CSS removes hands focus to its surviving presenter.
 * Observe only that control; a real focus transfer relinquishes the capture.
 */
export function useActionFocusRecovery(
  rootRef: RefObject<HTMLElement | null>,
  returnFocus: () => HTMLElement | null,
): void {
  const destination = useRef(returnFocus);
  useLayoutEffect(() => { destination.current = returnFocus; });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let captured: HTMLElement | null = null;
    let resize: ResizeObserver | null = null;
    const release = () => {
      captured?.removeEventListener("blur", blurred);
      document.removeEventListener("focusin", transferred, true);
      resize?.disconnect();
      resize = null;
      captured = null;
    };
    const recover = () => {
      if (!captured) return;
      const active = document.activeElement;
      if (active !== captured && active !== document.body && active !== null) {
        release();
        return;
      }
      if (captured.getClientRects().length > 0) return;
      release();
      destination.current()?.focus({ preventScroll: true });
    };
    const blurred = () => queueMicrotask(() => {
      recover();
      // Deliberate blur while still visible does not promise a later return.
      if (captured && document.activeElement !== captured) release();
    });
    const transferred = (event: FocusEvent) => {
      if (event.target !== captured) release();
    };
    const capture = (element: HTMLElement) => {
      release();
      captured = element;
      element.addEventListener("blur", blurred);
      document.addEventListener("focusin", transferred, true);
      resize = new ResizeObserver(recover);
      resize.observe(element);
    };
    const focused = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) capture(event.target);
    };
    root.addEventListener("focusin", focused);
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active)) capture(active);
    return () => {
      root.removeEventListener("focusin", focused);
      release();
    };
  }, [rootRef]);
}
