"use client";

import { type RefObject } from "react";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import { useReturnFocus } from "@/lib/ui/useReturnFocus";
import { useInitialFocus } from "@/lib/ui/useInitialFocus";

/**
 * The modal-sheet accessibility contract in one call: while `active`, lock body
 * scroll, trap Tab focus inside `ref`, move focus in on open and restore it on
 * close, and dismiss on Escape.
 *
 * Outside-click dismissal is intentionally NOT owned here. Modal sheets dismiss
 * via a backdrop `onClick` (portal-safe — see docs/cutovers/dialog-overlay-hook-
 * unification.md §9): the caller wires `onClick={onDismiss}` on the scrim and
 * `onClick={(e) => e.stopPropagation()}` on the panel.
 */
export function useDialogOverlay(args: {
  ref: RefObject<HTMLElement | null>;
  active: boolean;
  onDismiss: () => void;
  initialFocus?: (container: HTMLElement) => HTMLElement | null;
  returnFocusFallback?: () => HTMLElement | null;
  /**
   * Read at close time; when it returns true, focus is NOT restored to the opener
   * (a navigating dispatch already claimed focus at the destination). Dismissal
   * paths omit it and keep the default return-focus.
   */
  skipReturnFocus?: () => boolean;
  focusKey?: unknown;
}): void {
  const { ref, active, onDismiss, initialFocus, returnFocusFallback, skipReturnFocus, focusKey } =
    args;
  useBodyOverflowLock(active);
  useFocusTrap(ref, active);
  useReturnFocus(active, returnFocusFallback, { skip: skipReturnFocus });
  useInitialFocus(ref, active, { select: initialFocus, key: focusKey });
  useEscapeKey(active, onDismiss);
}
