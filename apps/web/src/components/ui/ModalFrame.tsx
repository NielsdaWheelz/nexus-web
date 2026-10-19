"use client";

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  OverlayContext,
  focusableElements,
  useOverlay,
  type DismissDecision,
  type ReturnFocusTarget,
  type Layer,
} from "@/lib/ui/overlay";

export interface ModalProps {
  readonly open: boolean;
  readonly scope?: string;
  /** Runs only after a dismissal is accepted. */
  readonly onDismiss: () => void;
  /** Asked by Escape, Back, the scrim and the frame's own close controls. */
  readonly onDismissRequest?: () => DismissDecision;
  /** What to focus on open unless content already took focus; else the first focusable, else the panel. */
  readonly initialFocus?: (panel: HTMLElement) => HTMLElement | null;
  /** Initial focus runs again when this changes while open. */
  readonly focusKey?: unknown;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly skipReturnFocus?: () => boolean;
  /** A creator can name this stable layer before opening it. */
  readonly interactionLayer?: RefObject<Layer | null>;
}

/**
 * The one modal frame: a scrim holding a role="dialog" panel, portaled to the
 * body and stacked by activation order. Only the topmost frame is aria-modal
 * and interactive; a covered frame is inert and its scrim clear. Mount-gated
 * or driven by `open`: either way a close leaves the stack.
 */
export default function ModalFrame({
  open,
  onDismiss,
  onDismissRequest,
  initialFocus,
  focusKey,
  returnFocusTo,
  returnFocusFallback,
  skipReturnFocus,
  interactionLayer,
  label,
  scope,
  id,
  keepMounted = false,
  backdropClassName,
  backdropStyle,
  className,
  children,
}: ModalProps & {
  readonly label: string;
  readonly id?: string;
  /** After the first open, keep the content mounted (hidden) while closed. */
  readonly keepMounted?: boolean;
  readonly backdropClassName: string;
  readonly backdropStyle?: CSSProperties;
  readonly className: string;
  readonly children: ReactNode | ((requestDismiss: () => void) => ReactNode);
}) {
  const requestDismiss = () => {
    if (onDismissRequest?.() !== "blocked") onDismiss();
  };
  const { layer, topmost, depth } = useOverlay(open, {
    kind: "modal",
    onDismiss: requestDismiss,
    scope,
    returnFocusTo,
    returnFocusFallback,
    skipReturnFocus,
  });
  useLayoutEffect(() => {
    if (!interactionLayer) return;
    interactionLayer.current = layer;
    return () => {
      if (interactionLayer.current === layer) interactionLayer.current = null;
    };
  }, [interactionLayer, layer]);

  // Once per open and focus key, when (or once) this frame is topmost.
  const select = useRef(initialFocus);
  select.current = initialFocus;
  const focused = useRef<{ readonly key: unknown } | null>(null);
  useEffect(() => {
    const panel = layer.element;
    if (!open) focused.current = null;
    if (!open || !topmost || !panel) return;
    if (focused.current && Object.is(focused.current.key, focusKey)) return;
    const changingKey = focused.current !== null;
    focused.current = null;
    const frame = requestAnimationFrame(() => {
      focused.current = { key: focusKey };
      const active = document.activeElement;
      if (!changingKey && active instanceof HTMLElement && panel.contains(active)
        && !active.closest("[hidden], [inert]") && active.getClientRects().length > 0) return;
      (select.current?.(panel) ?? focusableElements(panel)[0] ?? panel).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [layer, open, topmost, focusKey]);

  const opened = useRef(false);
  opened.current ||= open;
  if (typeof document === "undefined") return null;
  if (!open && !(keepMounted && opened.current)) return null;
  return createPortal(
    <OverlayContext value={layer}>
      <div
        className={backdropClassName}
        style={{ ...backdropStyle, zIndex: `calc(var(--z-modal) + ${depth})` }}
        role="presentation"
        hidden={!open}
        data-modal-backdrop="true"
        data-suspended={topmost ? undefined : "true"}
        // The kernel reads scrim clicks itself. This keeps a click in the frame
        // from reaching its owner through the React tree, and gives iOS Safari
        // the listener it wants before it dispatches a click on the scrim.
        onClick={(event) => event.stopPropagation()}
      >
        <section
          ref={(panel) => {
            layer.element = panel;
          }}
          id={id}
          className={className}
          role="dialog"
          aria-label={label}
          aria-modal={topmost || undefined}
          inert={!topmost}
          tabIndex={-1}
        >
          {typeof children === "function" ? children(requestDismiss) : children}
        </section>
      </div>
    </OverlayContext>,
    document.body,
  );
}
