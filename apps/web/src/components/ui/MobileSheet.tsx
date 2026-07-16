"use client";

import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/lib/ui/cx";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import { useHistoryDismiss, type DismissDecision } from "@/lib/ui/useHistoryDismiss";
import { useKeyboardInset } from "@/lib/ui/useKeyboardInset";
import styles from "./MobileSheet.module.css";

const DRAG_DISMISS_PX = 96;

interface MobileSheetProps {
  /** Render/behavior gate. The component must stay mounted; gate with this. */
  active: boolean;
  /** Backdrop tap, drag-past-threshold, back button. */
  onDismiss: () => void;
  /**
   * Dirty guard consulted before backdrop tap, drag-dismiss, back button, and
   * Escape (when no `onEscape` override). Return "blocked" to keep the sheet
   * open (e.g. to show a discard confirmation); "accepted" or absent dismisses
   * via `onDismiss`.
   */
  onDismissRequest?: () => DismissDecision;
  /** Escape override (default: the dismiss request). Palette uses this to pop a level. */
  onEscape?: () => void;
  ariaLabel: string;
  children: ReactNode;

  /** Z-layer token. Default "modal". */
  layer?: "overlay" | "modal" | "palette";
  /** Scrim token. Default "default" (--overlay-scrim); "soft" for context sheets. */
  scrim?: "default" | "soft";
  /** Grabber + drag-to-dismiss. Default true. */
  grabber?: boolean;
  /** Back-button dismissal. Default true. */
  historyDismiss?: boolean;

  /** Forwarded to useDialogOverlay. */
  initialFocus?: (container: HTMLElement) => HTMLElement | null;
  returnFocusFallback?: () => HTMLElement | null;
  /** Read at close time; true ⇒ skip return-focus (destination already claimed it). */
  skipReturnFocus?: () => boolean;
  focusKey?: unknown;

  /** Skin on the panel (e.g. palette glass). Geometry stays in MobileSheet.module.css. */
  panelClassName?: string;
  /** Stable test ids for backdrop/panel (existing tests keep their selectors). */
  backdropTestId?: string;
  panelTestId?: string;
}

/**
 * The single mobile bottom-sheet owner (docs/cutovers/mobile-sheet-keyboard-
 * unification-hard-cutover.md): portal, scrim, grabber + drag-to-dismiss,
 * keyboard avoidance (shrink + lift via --keyboard-inset), safe-area padding,
 * back-button dismissal, and the useDialogOverlay modal contract.
 *
 * Mount contract: keep this component mounted across the open/close cycle and
 * drive it with `active` — never `open && <MobileSheet …>`. useHistoryDismiss
 * (C7) needs to observe `active` going false to pop its synthetic entry.
 */
export default function MobileSheet({
  active,
  onDismiss,
  onDismissRequest,
  onEscape,
  ariaLabel,
  children,
  layer = "modal",
  scrim = "default",
  grabber = true,
  historyDismiss = true,
  initialFocus,
  returnFocusFallback,
  skipReturnFocus,
  focusKey,
  panelClassName,
  backdropTestId,
  panelTestId,
}: MobileSheetProps) {
  const panelRef = useRef<HTMLElement>(null);
  const dragStartRef = useRef<number | null>(null);
  const inset = useKeyboardInset();

  // Route every dismissal path (backdrop, drag, back button, default Escape)
  // through the optional dirty guard. No guard ⇒ plain dismiss (unchanged).
  const requestDismiss = useCallback((): DismissDecision => {
    const decision = onDismissRequest ? onDismissRequest() : "accepted";
    if (decision === "accepted") onDismiss();
    return decision;
  }, [onDismissRequest, onDismiss]);

  useDialogOverlay({
    ref: panelRef,
    active,
    onDismiss: onEscape ?? requestDismiss,
    initialFocus,
    returnFocusFallback,
    skipReturnFocus,
    focusKey,
  });
  useHistoryDismiss(active && historyDismiss, requestDismiss);

  function onPointerDown(event: React.PointerEvent) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!(event.target instanceof Element) || !event.target.closest("[data-grabber]")) return;
    event.currentTarget.setPointerCapture(event.pointerId); // keep move/up even if the flick leaves the sheet
    dragStartRef.current = event.clientY;
  }
  function onPointerMove(event: React.PointerEvent) {
    if (dragStartRef.current === null || !panelRef.current) return;
    panelRef.current.style.transform = `translateY(${Math.max(0, event.clientY - dragStartRef.current)}px)`;
  }
  function onPointerUp(event: React.PointerEvent) {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (start === null || !panelRef.current) return;
    panelRef.current.style.transform = "";
    if (event.clientY - start > DRAG_DISMISS_PX) requestDismiss();
  }

  if (!active) return null;
  return createPortal(
    <div
      className={styles.backdrop}
      data-layer={layer}
      data-scrim={scrim}
      data-testid={backdropTestId}
      role="presentation"
      onClick={requestDismiss}
    >
      <section
        ref={panelRef}
        className={cx(styles.panel, panelClassName)}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        data-testid={panelTestId}
        style={{ "--keyboard-inset": `${inset}px` } as CSSProperties}
        onClick={(event) => event.stopPropagation()}
        {...(grabber
          ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }
          : null)}
      >
        {grabber ? <div className={styles.grabber} data-grabber aria-hidden="true" /> : null}
        <div className={styles.content}>{children}</div>
      </section>
    </div>,
    document.body,
  );
}
