"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import styles from "./Dialog.module.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
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
 * scroll lock). Mount-gate it — render only while open (`{open && <Dialog …>}`
 * or `open ? <Dialog …/> : null`), matching all existing consumers.
 */
export default function Dialog({ open, onClose, title, children, onDismissRequest }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const requestDismiss = useCallback(() => {
    if (onDismissRequest && onDismissRequest() === "blocked") return;
    onClose();
  }, [onDismissRequest, onClose]);

  useDialogOverlay({ ref: panelRef, active: open, onDismiss: requestDismiss });

  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} role="presentation" onClick={requestDismiss}>
      <div
        ref={panelRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
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
    </div>,
    document.body,
  );
}
