"use client";

import { useCallback, useLayoutEffect, type RefObject } from "react";
import { useActiveMobileViewport } from "@/lib/mobileViewport/MobileViewportProvider";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  useHistoryDismiss,
  type DismissDecision,
} from "@/lib/ui/useHistoryDismiss";
import { useKeyboardInset } from "@/lib/ui/useKeyboardInset";
import type { ModalLayerToken } from "@/lib/ui/useModalLayer";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";

export interface MobileModalLifecycleInput {
  panelRef: RefObject<HTMLElement | null>;
  active: boolean;
  onDismiss(): void;
  onDismissRequest?: () => DismissDecision;
  onEscape?: () => void;
  historyDismiss?: boolean;
  initialFocus?: (container: HTMLElement) => HTMLElement | null;
  returnFocusTo?: ReturnFocusTarget;
  returnFocusFallback?: ReturnFocusTarget;
  skipReturnFocus?: () => boolean;
  focusKey?: unknown;
  layerScope?: string;
}

export interface MobileModalLifecycle {
  layerToken: ModalLayerToken;
  isTopmost: boolean;
  requestDismiss(): DismissDecision;
  keyboardBottomInsetPx: number;
  visualViewportTopPx: number;
}

/**
 * Shared mechanics for mobile modal surfaces. Semantic primitives retain
 * ownership of their own markup, geometry, gestures, and presentation.
 */
export function useMobileModalLifecycle({
  panelRef,
  active,
  onDismiss,
  onDismissRequest,
  onEscape,
  historyDismiss = true,
  initialFocus,
  returnFocusTo,
  returnFocusFallback,
  skipReturnFocus,
  focusKey,
  layerScope,
}: MobileModalLifecycleInput): MobileModalLifecycle {
  const { keyboardBottomInsetPx, visualViewportTopPx } = useKeyboardInset();
  const mobileViewport = useActiveMobileViewport(active);
  const requestDismiss = useCallback((): DismissDecision => {
    const decision = onDismissRequest?.() ?? "accepted";
    if (decision === "accepted") {
      onDismiss();
    }
    return decision;
  }, [onDismiss, onDismissRequest]);
  const overlay = useDialogOverlay({
    ref: panelRef,
    active,
    onDismiss: onEscape ?? requestDismiss,
    initialFocus,
    returnFocusTo,
    returnFocusFallback,
    skipReturnFocus,
    focusKey,
    layerScope,
  });

  useHistoryDismiss(active && historyDismiss, requestDismiss, {
    isTopmost: overlay.isTopmost,
  });
  useLayoutEffect(() => {
    if (!active || !mobileViewport) {
      return;
    }
    return mobileViewport.reportMobileOverlayKeyboardInset(
      keyboardBottomInsetPx,
    );
  }, [active, keyboardBottomInsetPx, mobileViewport]);

  return {
    layerToken: overlay.layerToken,
    isTopmost: overlay.isTopmost,
    requestDismiss,
    keyboardBottomInsetPx,
    visualViewportTopPx,
  };
}
