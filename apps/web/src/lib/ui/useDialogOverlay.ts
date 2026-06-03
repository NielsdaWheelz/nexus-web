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
  focusKey?: unknown;
}): void {
  const { ref, active, onDismiss, initialFocus, returnFocusFallback, focusKey } = args;
  useBodyOverflowLock(active);
  useFocusTrap(ref, active);
  useReturnFocus(active, returnFocusFallback);
  useInitialFocus(ref, active, { select: initialFocus, key: focusKey });
  useEscapeKey(active, onDismiss);
}
