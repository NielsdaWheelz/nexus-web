"use client";

import type { ReactNode } from "react";
import { useKeyboardInset, useKeyboardReport } from "@/lib/ui/useKeyboardInset";
import ModalFrame, { type ModalProps } from "./ModalFrame";
import styles from "./MobileFullScreenTask.module.css";

/**
 * The opaque mobile task, fixed to the unobscured visual viewport: its top
 * follows the iOS viewport pan, its bottom clears the keyboard, and content
 * clears the remaining system bar. Content stays mounted after the first open.
 */
export default function MobileFullScreenTask({
  active,
  ariaLabel,
  children,
  panelId,
  ...modal
}: Omit<ModalProps, "open" | "initialFocus"> & {
  readonly active: boolean;
  readonly panelId?: string;
  readonly initialFocus: NonNullable<ModalProps["initialFocus"]>;
  readonly focusKey: unknown;
  readonly ariaLabel: string;
  readonly children: ReactNode | ((requestDismiss: () => void) => ReactNode);
}) {
  const { keyboardBottomInsetPx, visualViewportTopPx } = useKeyboardInset();
  useKeyboardReport(active);
  return (
    <ModalFrame
      {...modal}
      open={active}
      label={ariaLabel}
      id={panelId}
      scope={modal.scope ?? panelId}
      keepMounted
      backdropClassName={styles.projection}
      backdropStyle={{
        top: visualViewportTopPx,
        bottom: keyboardBottomInsetPx,
      }}
      className={styles.frame}
    >
      {(requestDismiss) => <div className={styles.content} style={{ paddingBottom: `max(0px, calc(var(--viewport-safe-bottom) - ${keyboardBottomInsetPx}px))` }}>
        {typeof children === "function" ? children(requestDismiss) : children}
      </div>}
    </ModalFrame>
  );
}
