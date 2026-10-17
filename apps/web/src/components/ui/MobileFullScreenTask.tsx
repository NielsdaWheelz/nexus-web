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
  ...modal
}: Omit<ModalProps, "open" | "onDismissRequest" | "initialFocus"> & {
  readonly active: boolean;
  readonly onDismissRequest: NonNullable<ModalProps["onDismissRequest"]>;
  readonly initialFocus: NonNullable<ModalProps["initialFocus"]>;
  readonly focusKey: unknown;
  readonly ariaLabel: string;
  readonly children: ReactNode;
}) {
  const { keyboardBottomInsetPx, visualViewportTopPx } = useKeyboardInset();
  useKeyboardReport(active);
  return (
    <ModalFrame
      {...modal}
      open={active}
      label={ariaLabel}
      keepMounted
      backdropClassName={styles.projection}
      backdropStyle={{
        top: visualViewportTopPx,
        bottom: keyboardBottomInsetPx,
      }}
      className={styles.frame}
    >
      <div className={styles.content} style={{ paddingBottom: `max(0px, calc(var(--viewport-safe-bottom) - ${keyboardBottomInsetPx}px))` }}>{children}</div>
    </ModalFrame>
  );
}
