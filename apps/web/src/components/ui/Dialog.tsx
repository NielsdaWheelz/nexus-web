"use client";
import * as Icon from "@/lib/ui/icons";

import { useRef, type ReactNode } from "react";
import { useKeyboardInset } from "@/lib/ui/useKeyboardInset";
import { useCollectionLayout } from "@/lib/ui/collection";
import { cx } from "@/lib/ui/cx";
import ModalFrame, { type ModalProps } from "./ModalFrame";
import styles from "./Dialog.module.css";

/** The centred modal: a titled header with a close button over a scrolling body. */
export default function Dialog({
  onClose,
  title,
  className,
  children,
  ...modal
}: Omit<ModalProps, "onDismiss" | "focusKey"> & {
  readonly onClose: () => void;
  readonly title: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const { keyboardBottomInsetPx, visualViewportTopPx } = useKeyboardInset();
  useCollectionLayout(body, modal.open);
  return (
    <ModalFrame
      {...modal}
      slipContent={modal.slipContent ?? body}
      onDismiss={onClose}
      label={title}
      backdropClassName={styles.backdrop}
      backdropStyle={{ top: visualViewportTopPx, bottom: keyboardBottomInsetPx }}
      className={cx(styles.dialog, className)}
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
              <Icon.Dismiss size={16} />
            </button>
          </header>
          <div ref={body} className={styles.body}>{children}</div>
        </>
      )}
    </ModalFrame>
  );
}
