"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useKeyboardReport } from "@/lib/ui/useKeyboardInset";
import ModalFrame, { type ModalProps } from "./ModalFrame";
import styles from "./MobileSheet.module.css";

const DRAG_DISMISS_PX = 96;
const HEADER_CONTROLS = "a, button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [contenteditable], [tabindex]";

/**
 * A titled mobile sheet with an independently scrolling body. Every exit asks
 * the frame's dismissal guard. Specialized headers replace the title and x and
 * must provide their own visible exit through requestDismiss. Only the header's
 * noninteractive space drags; reduced motion removes travel, not dismissal.
 */
export default function MobileSheet({
  active,
  ariaLabel,
  scrim = "default",
  panelId,
  children,
  renderHeader,
  ...modal
}: Omit<ModalProps, "open"> & {
  readonly active: boolean;
  readonly ariaLabel: string;
  /** "soft" for in-context companion sheets. */
  readonly scrim?: "default" | "soft";
  /** The panel's id; also its interaction scope. */
  readonly panelId?: string;
  readonly children: ReactNode;
  readonly renderHeader?: (input: { readonly requestDismiss: () => void }) => ReactNode;
}) {
  const dragStart = useRef<{ readonly pointerId: number; readonly y: number } | null>(null);
  useKeyboardReport(active);
  const drag = (event: PointerEvent<HTMLElement>, offset: number | null) => {
    const panel = event.currentTarget.parentElement;
    if (panel) panel.style.transform = offset === null ? "" : `translateY(${offset}px)`;
  };

  return (
    <ModalFrame
      {...modal}
      open={active}
      label={ariaLabel}
      id={panelId}
      scope={panelId}
      backdropClassName={scrim === "soft" ? styles.softBackdrop : styles.backdrop}
      className={styles.panel}
    >
      {(requestDismiss) => (
        <>
          <div
            className={styles.header}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              const control = event.target instanceof Element ? event.target.closest(HEADER_CONTROLS) : null;
              if (control && event.currentTarget.contains(control)) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStart.current = { pointerId: event.pointerId, y: event.clientY };
            }}
            onPointerMove={(event) => {
              const start = dragStart.current;
              if (start?.pointerId !== event.pointerId || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
              drag(event, Math.max(0, event.clientY - start.y));
            }}
            onPointerUp={(event) => {
              const start = dragStart.current;
              if (start?.pointerId !== event.pointerId) return;
              dragStart.current = null;
              drag(event, null);
              if (event.clientY - start.y >= DRAG_DISMISS_PX) requestDismiss();
            }}
            onPointerCancel={(event) => {
              if (dragStart.current?.pointerId !== event.pointerId) return;
              dragStart.current = null;
              drag(event, null);
            }}
          >
            <div className={styles.grabber} aria-hidden="true" />
            {renderHeader ? renderHeader({ requestDismiss }) : (
              <div className={styles.titleRow}>
                <h2 className={styles.title}>{ariaLabel}</h2>
                <button type="button" className={styles.close} aria-label={`close ${ariaLabel}`} onClick={requestDismiss}>
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
          <div className={styles.content}>{children}</div>
        </>
      )}
    </ModalFrame>
  );
}
