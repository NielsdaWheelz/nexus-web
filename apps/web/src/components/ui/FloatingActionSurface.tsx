"use client";

import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "@/lib/ui/cx";
import { focusableElements, useOverlay, useOverlayContainer } from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./FloatingActionSurface.module.css";

/**
 * The non-modal action surface for text selections, clicked highlights,
 * composers and action-bar popovers. Escape (and, inside a modal, Back) and a
 * press outside the surface and its anchor element dismiss it. It follows its
 * anchor through scroll, resize and the mobile bottom chrome.
 */
export default function FloatingActionSurface({
  open,
  id,
  disclosure = false,
  disclosureTrigger,
  placement,
  anchor,
  strategy = "anchor",
  lineRects,
  align = "center",
  flip = false,
  preservePointerSelection = false,
  role,
  label,
  className,
  onDismiss,
  children,
}: {
  readonly open: boolean;
  readonly id?: string;
  /** An explicitly opened details surface, in the anchor's logical tab order. */
  readonly disclosure?: boolean;
  /** The actual control when the positioned anchor includes its whole row. */
  readonly disclosureTrigger?: HTMLElement | null;
  readonly placement?: "above" | "below";
  readonly anchor: HTMLElement | DOMRect | null;
  /** "text-selection": above the first selected line, with a caret. */
  readonly strategy?: "anchor" | "text-selection";
  readonly lineRects?: readonly DOMRect[];
  readonly align?: "start" | "center" | "end";
  /** Below the anchor, or above it when below does not fit. */
  readonly flip?: boolean;
  /** A press inside does not collapse the live text selection. */
  readonly preservePointerSelection?: boolean;
  readonly role?: "group" | "toolbar" | "dialog";
  readonly label?: string;
  readonly className?: string;
  /** Back inside a modal reports "escape". */
  readonly onDismiss: (reason: "outside-click" | "escape") => void;
  readonly children: ReactNode;
}) {
  const shown = open && anchor !== null;
  const trigger = disclosureTrigger ?? (typeof HTMLElement !== "undefined" && anchor instanceof HTMLElement ? anchor : null);
  const position = useAnchoredPosition<HTMLDivElement>(anchor, {
    enabled: shown,
    align,
    placement,
    keepAnchorVisible: disclosure,
    gap: 8,
    flip,
    lines: strategy === "text-selection" ? (lineRects ?? []) : undefined,
    clearContent: true,
  });
  const container = useOverlayContainer();
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const skipReturn = useRef(false);
  const focused = useRef(false);
  useOverlay(shown, {
    kind: "transient",
    returnFocus: disclosure,
    returnFocusTo: () => trigger ? { element: trigger, preventScroll: true } : null,
    skipReturnFocus: () => skipReturn.current,
    onDismiss: (reason) =>
      dismiss.current(reason === "outside" ? "outside-click" : "escape"),
    inside: () => [
      position.ref.current,
      anchor instanceof HTMLElement ? anchor : null,
      trigger,
    ],
  });

  useLayoutEffect(() => {
    if (!shown) {
      focused.current = false;
      skipReturn.current = false;
      return;
    }
    const surface = position.ref.current;
    if (!disclosure || !position.placed || !surface || focused.current) return;
    focused.current = true;
    (focusableElements(surface)[0] ?? surface).focus({ preventScroll: true });
  }, [shown, disclosure, position.placed, position.ref]);

  // Children shrink to the clamped box, net of the surface's padding and border.
  const { maxWidth, maxHeight } = position.style;
  useLayoutEffect(() => {
    const surface = position.ref.current;
    if (!surface || typeof maxWidth !== "number") return;
    if (typeof maxHeight !== "number") return;
    const computed = getComputedStyle(surface);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const inline =
      px(computed.paddingLeft) +
      px(computed.paddingRight) +
      px(computed.borderLeftWidth) +
      px(computed.borderRightWidth);
    const block =
      px(computed.paddingTop) +
      px(computed.paddingBottom) +
      px(computed.borderTopWidth) +
      px(computed.borderBottomWidth);
    surface.style.setProperty(
      "--floating-action-content-max-width",
      `${Math.max(0, maxWidth - inline)}px`,
    );
    surface.style.setProperty(
      "--floating-action-content-max-height",
      `${Math.max(0, maxHeight - block)}px`,
    );
  }, [position.ref, maxWidth, maxHeight]);

  if (!shown || !container) return null;
  const caret =
    position.caretX === null
      ? undefined
      : { "--floating-action-caret-inline-offset": `${position.caretX}px` };
  return createPortal(
    <div
      ref={position.ref}
      id={id}
      tabIndex={disclosure ? -1 : undefined}
      data-disclosure={disclosure || undefined}
      className={cx(styles.surface, className)}
      style={{ ...position.style, ...caret } as CSSProperties}
      role={role}
      aria-label={label}
      data-placement={position.side}
      data-positioned={position.placed ? "true" : "false"}
      data-strategy={strategy}
      onKeyDown={(event) => {
        if (!disclosure || event.key !== "Tab" || !trigger) return;
        const surface = position.ref.current;
        if (!surface) return;
        const controls = focusableElements(surface);
        const atEdge = event.shiftKey
          ? document.activeElement === controls[0] || controls.length === 0
          : document.activeElement === controls.at(-1) || controls.length === 0;
        if (!atEdge) return;
        skipReturn.current = true;
        if (event.shiftKey) {
          event.preventDefault();
          trigger.focus({ preventScroll: true });
        } else {
          const page = focusableElements(container).filter((element) => !surface.contains(element) && element.getClientRects().length > 0);
          const next = page[page.indexOf(trigger) + 1];
          if (next) {
            event.preventDefault();
            next.focus({ preventScroll: true });
          } else {
            // Let the browser continue beyond the document from the trigger.
            trigger.focus({ preventScroll: true });
          }
        }
        dismiss.current("outside-click");
      }}
      onPointerDown={(event) => {
        if (preservePointerSelection) event.preventDefault();
      }}
    >
      {children}
    </div>,
    container,
  );
}
