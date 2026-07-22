"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import styles from "./Dialog.module.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Forwarded to useDialogOverlay: pick the element focused on open (e.g. a
   * search field) instead of the default first-focusable (the close button). */
  initialFocus?: (container: HTMLElement) => HTMLElement | null;
  returnFocusTo?: ReturnFocusTarget;
  returnFocusFallback?: ReturnFocusTarget;
  /**
   * Read at close time; true ⇒ skip return-focus because a navigating dispatch
   * already claimed focus at its destination. Dismissal paths omit it and keep
   * the default return-focus. Mirrors the `MobileSheet` handoff.
   */
  skipReturnFocus?: () => boolean;
  /**
   * Consulted by every dismissal affordance the dialog renders — Escape,
   * backdrop, and the close (X) button. Return "blocked" to keep the dialog open
   * (e.g. to show a dirty-changes confirmation); "accepted" or absent dismisses
   * via `onClose`.
   */
  onDismissRequest?: () => DismissDecision;
}

/**
 * The shared modal Dialog owner, on the repository's `useDialogOverlay` contract
 * (portal, role="dialog" aria-modal, focus trap, return focus, Escape, body
 * scroll lock). Consumers may keep the component mounted and control `open`, or
 * mount-gate it when they do not need persistent child state.
 */
export default function Dialog({
  open,
  onClose,
  title,
  children,
  initialFocus,
  returnFocusTo,
  returnFocusFallback,
  skipReturnFocus,
  onDismissRequest,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const requestDismiss = useCallback(() => {
    if (onDismissRequest && onDismissRequest() === "blocked") return;
    onClose();
  }, [onDismissRequest, onClose]);

  const overlay = useDialogOverlay({
    ref: panelRef,
    active: open,
    onDismiss: requestDismiss,
    initialFocus,
    returnFocusTo,
    returnFocusFallback,
    skipReturnFocus,
  });

  if (!open) return null;

  return createPortal(
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.backdrop}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
        onClick={requestDismiss}
      >
        <div
          ref={panelRef}
          className={styles.dialog}
          role="dialog"
          aria-label={title}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.inner}>
            <header className={styles.header}>
              <h2 className={styles.title}>{title}</h2>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={requestDismiss}
                aria-label="Close dialog"
              >
                <X size={16} />
              </button>
            </header>
            <div className={styles.body}>{children}</div>
          </div>
        </div>
      </div>
    </ModalLayerProvider>,
    document.body,
  );
}
