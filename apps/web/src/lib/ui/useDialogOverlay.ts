"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import {
  useReturnFocus,
  type ReturnFocusTarget,
} from "@/lib/ui/useReturnFocus";
import { useInitialFocus } from "@/lib/ui/useInitialFocus";
import {
  useModalLayer,
  type ModalLayerToken,
} from "@/lib/ui/useModalLayer";

interface DialogOverlayState {
  readonly isTopmost: boolean;
  readonly layerToken: ModalLayerToken;
}

/**
 * The modal-sheet accessibility contract in one call: while `active`, lock body
 * scroll, register a modal layer, and project modal semantics. Only the topmost
 * layer receives `aria-modal`, traps/initializes focus, and owns Escape; lower
 * layers are inert until exposed. Return focus is stack-aware.
 *
 * Outside-click dismissal is intentionally NOT owned here. Modal sheets dismiss
 * via a backdrop `onClick` (portal-safe — see docs/modules/overlays.md): the
 * caller wires `onClick={onDismiss}` on the scrim and
 * `onClick={(e) => e.stopPropagation()}` on the panel.
 */
export function useDialogOverlay(args: {
  ref: RefObject<HTMLElement | null>;
  active: boolean;
  onDismiss: () => void;
  initialFocus?: (container: HTMLElement) => HTMLElement | null;
  returnFocusTo?: ReturnFocusTarget;
  returnFocusFallback?: ReturnFocusTarget;
  /**
   * Read at close time; when it returns true, focus is NOT restored to the opener
   * (a navigating dispatch already claimed focus at the destination). Dismissal
   * paths omit it and keep the default return-focus.
   */
  skipReturnFocus?: () => boolean;
  focusKey?: unknown;
  /** Stable semantic scope for commands that are valid on this modal layer. */
  layerScope?: string;
}): DialogOverlayState {
  const {
    ref,
    active,
    onDismiss,
    initialFocus,
    returnFocusTo,
    returnFocusFallback,
    skipReturnFocus,
    focusKey,
    layerScope,
  } = args;
  const modalLayer = useModalLayer(active);
  const { isTopmost } = modalLayer;
  const topmostWhileActiveRef = useRef(isTopmost);
  if (active) topmostWhileActiveRef.current = isTopmost;
  useLayoutEffect(() => {
    if (!active || !ref.current) return;
    const container = ref.current;
    container.inert = !isTopmost;
    if (isTopmost) container.setAttribute("aria-modal", "true");
    else container.removeAttribute("aria-modal");
    return () => {
      container.inert = false;
      container.removeAttribute("aria-modal");
    };
  }, [active, isTopmost, ref]);
  useBodyOverflowLock(active);
  useFocusTrap(ref, active && isTopmost);
  useReturnFocus(active, {
    returnFocusTo,
    returnFocusFallback,
    skip: () =>
      !topmostWhileActiveRef.current || (skipReturnFocus?.() ?? false),
  });
  useInitialFocus(ref, active, {
    enabled: isTopmost,
    select: initialFocus,
    key: focusKey,
  });
  useEscapeKey(active && isTopmost, onDismiss, {
    layer: "modal",
    modalToken: modalLayer.token,
    scope: layerScope,
  });
  return { isTopmost, layerToken: modalLayer.token };
}
