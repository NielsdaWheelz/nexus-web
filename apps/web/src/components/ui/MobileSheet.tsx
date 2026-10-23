"use client";

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useCollectionLayout } from "@/lib/ui/collection";
import { useKeyboardReport } from "@/lib/ui/useKeyboardInset";
import ModalFrame, { type ModalProps } from "./ModalFrame";
import styles from "./MobileSheet.module.css";

const DRAG_DISMISS_PX = 96;
const TAP_SLOP_PX = 8;
const HEADER_CONTROLS = "a, button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [contenteditable], [tabindex]";

type Header =
  | { readonly handleLabel: string; readonly renderHeader?: never }
  | {
      readonly handleLabel?: never;
      readonly renderHeader?: (input: { readonly requestDismiss: () => void }) => ReactNode;
    };

/**
 * A mobile sheet with an independently scrolling body. Every exit asks the
 * frame's dismissal guard. A handle replaces the title and x with a native
 * tap/drag button; specialized headers provide their own visible exit through
 * requestDismiss. Other header controls never drag. Moved or cancelled gestures
 * cannot click; reduced motion removes travel, not dismissal.
 */
export default function MobileSheet({
  active,
  ariaLabel,
  scrim = "default",
  panelId,
  children,
  handleLabel,
  renderHeader,
  ...modal
}: Omit<ModalProps, "open"> & Header & {
  readonly active: boolean;
  readonly ariaLabel: string;
  /** "soft" for in-context companion sheets. */
  readonly scrim?: "default" | "soft";
  /** The panel's id; also its interaction scope. */
  readonly panelId?: string;
  readonly children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  useCollectionLayout(content, active);
  const dragStart = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  useKeyboardReport(active);
  useEffect(() => {
    if (!active) {
      dragStart.current = null;
      suppressClick.current = false;
    }
  }, [active]);
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
            className={handleLabel === undefined ? styles.header : `${styles.header} ${styles.handleHeader}`}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0 || dragStart.current) return;
              suppressClick.current = false;
              let control = event.target instanceof Element ? event.target.closest(HEADER_CONTROLS) : null;
              if (control && !event.currentTarget.contains(control)) control = null;
              if (control && handleLabel === undefined) return;
              (control ?? event.currentTarget).setPointerCapture(event.pointerId);
              dragStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
            }}
            onPointerMove={(event) => {
              const start = dragStart.current;
              if (start?.pointerId !== event.pointerId) return;
              start.moved ||= Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX;
              if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
                drag(event, Math.max(0, event.clientY - start.y));
            }}
            onPointerUp={(event) => {
              const start = dragStart.current;
              if (start?.pointerId !== event.pointerId) return;
              dragStart.current = null;
              suppressClick.current = start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX;
              drag(event, null);
              if (event.clientY - start.y >= DRAG_DISMISS_PX) requestDismiss();
            }}
            onPointerCancel={(event) => {
              if (dragStart.current?.pointerId !== event.pointerId) return;
              dragStart.current = null;
              suppressClick.current = true;
              drag(event, null);
            }}
            onLostPointerCapture={(event) => {
              if (dragStart.current?.pointerId !== event.pointerId) return;
              dragStart.current = null;
              suppressClick.current = true;
              drag(event, null);
            }}
            onClickCapture={(event) => {
              const suppress = suppressClick.current && event.detail > 0;
              suppressClick.current = false;
              if (suppress) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            {handleLabel === undefined ? <div className={styles.grabber} aria-hidden="true" /> : null}
            {handleLabel !== undefined ? (
              <button type="button" className={styles.handle} aria-label={handleLabel} onClick={requestDismiss}>
                <span className={styles.grabber} aria-hidden="true" />
              </button>
            ) : renderHeader ? renderHeader({ requestDismiss }) : (
              <div className={styles.titleRow}>
                <h2 className={styles.title}>{ariaLabel}</h2>
                <button type="button" className={styles.close} aria-label={`close ${ariaLabel}`} onClick={requestDismiss}>
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
          <div ref={content} className={styles.content}>{children}</div>
        </>
      )}
    </ModalFrame>
  );
}
