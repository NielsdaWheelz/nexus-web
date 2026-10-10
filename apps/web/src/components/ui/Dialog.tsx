"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import ModalFrame, { type ModalProps } from "./ModalFrame";
import styles from "./Dialog.module.css";

/** The centred modal: a titled header with a close button over a scrolling body. */
export default function Dialog({
  onClose,
  title,
  children,
  ...modal
}: Omit<ModalProps, "onDismiss" | "focusKey"> & {
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <ModalFrame
      {...modal}
      onDismiss={onClose}
      label={title}
      backdropClassName={styles.backdrop}
      className={styles.dialog}
    >
      {(requestDismiss) => (
        <>
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
        </>
      )}
    </ModalFrame>
  );
}
