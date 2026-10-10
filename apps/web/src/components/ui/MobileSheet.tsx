"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";
import { useKeyboardReport } from "@/lib/ui/useKeyboardInset";
import ModalFrame, { type ModalProps } from "./ModalFrame";
import styles from "./MobileSheet.module.css";

const DRAG_DISMISS_PX = 96;

/**
 * The mobile bottom sheet: scrim, grabber drag-to-dismiss, keyboard lift and
 * safe-area padding. Escape, Back, a scrim tap and the drag ask the guard.
 */
export default function MobileSheet({
  active,
  ariaLabel,
  scrim = "default",
  panelId,
  children,
  ...modal
}: Omit<ModalProps, "open"> & {
  readonly active: boolean;
  readonly ariaLabel: string;
  /** "soft" for in-context companion sheets. */
  readonly scrim?: "default" | "soft";
  /** The panel's id; also its interaction scope. */
  readonly panelId?: string;
  readonly children: ReactNode;
}) {
  const dragStart = useRef<number | null>(null);
  useKeyboardReport(active);
  // The grabber moves its panel.
  const drag = (event: PointerEvent<HTMLElement>, offset: number | null) => {
    const panel = event.currentTarget.parentElement;
    if (panel) {
      panel.style.transform = offset === null ? "" : `translateY(${offset}px)`;
    }
  };

  return (
    <ModalFrame
      {...modal}
      open={active}
      label={ariaLabel}
      id={panelId}
      scope={panelId}
      backdropClassName={
        scrim === "soft" ? styles.softBackdrop : styles.backdrop
      }
      className={styles.panel}
    >
      {(requestDismiss) => (
        <>
          <div
            className={styles.grabber}
            aria-hidden="true"
            onPointerDown={(event) => {
              if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
                return;
              }
              // Keep move and up even when the flick leaves the grabber.
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStart.current = event.clientY;
            }}
            onPointerMove={(event) => {
              if (dragStart.current === null) return;
              drag(event, Math.max(0, event.clientY - dragStart.current));
            }}
            onPointerUp={(event) => {
              const start = dragStart.current;
              dragStart.current = null;
              if (start === null) return;
              drag(event, null);
              if (event.clientY - start > DRAG_DISMISS_PX) requestDismiss();
            }}
            onPointerCancel={(event) => {
              dragStart.current = null;
              drag(event, null);
            }}
          />
          <div className={styles.content}>{children}</div>
        </>
      )}
    </ModalFrame>
  );
}
