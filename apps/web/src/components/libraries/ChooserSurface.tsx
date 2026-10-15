"use client";

// Where a library chooser shows: on desktop a panel anchored below its trigger
// (a transient layer: Escape, an outside press and, inside a modal, Back close
// it), on phones the shared MobileSheet. Inline, it is a region in the caller's
// layout instead: Escape and Back close it, an outside press does not (collapsing
// would move the control the press meant to reach). It owns no chooser content;
// the chooser's search takes focus once the desktop panel is placed.

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import {
  useOverlay,
  useOverlayContainer,
  type ReturnFocusTarget,
} from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./ChooserSurface.module.css";

export default function ChooserSurface({
  active,
  inline = false,
  onClose,
  anchor,
  returnFocusFallback,
  skipReturnFocus,
  title,
  focusKey,
  panelId,
  children,
}: {
  readonly active: boolean;
  /** A region in the caller's layout, not the anchored panel or the sheet. */
  readonly inline?: boolean;
  /** Null while the caller finishes a creation: nothing closes it. */
  readonly onClose: (() => void) | null;
  /** Positions the panel and takes focus back on close. */
  readonly anchor: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  /** Read at close: true when the caller already moved focus elsewhere. */
  readonly skipReturnFocus?: () => boolean;
  /** The surface's accessible name. */
  readonly title: string;
  /** A new key refocuses the sheet or region (a new session). */
  readonly focusKey?: unknown;
  readonly panelId?: string;
  readonly children: ReactNode;
}) {
  const isMobile = useIsMobileViewport();
  const region = active && inline;
  const desktop = active && !inline && !isMobile;
  const regionRef = useRef<HTMLDivElement>(null);
  const target = desktop ? anchor() : null;
  const anchorEl = target === null || target instanceof HTMLElement ? target : target.element;
  const panel = useAnchoredPosition<HTMLDivElement>(anchorEl, {
    enabled: desktop,
    placement: "below",
    align: "start",
    flip: true,
  });
  const container = useOverlayContainer();
  useOverlay(desktop || region, {
    kind: "transient",
    onDismiss: () => onClose?.(),
    inside: region ? undefined : () => [panel.ref.current, anchorEl],
    returnFocus: true,
    returnFocusTo: anchor,
    returnFocusFallback,
    skipReturnFocus,
  });
  useEffect(() => {
    if (!desktop || !panel.placed) return;
    const frame = requestAnimationFrame(() =>
      panel.ref.current?.querySelector<HTMLInputElement>("input")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [desktop, panel.placed, panel.ref]);
  useEffect(() => {
    if (!region) return;
    // The region takes focus, not its search: no phone keyboard unasked.
    const frame = requestAnimationFrame(() => regionRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [region, focusKey]);

  if (region) {
    return (
      <div
        id={panelId}
        ref={regionRef}
        role="region"
        aria-label={title}
        tabIndex={-1}
        className={styles.inline}
      >
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
          <Button
            variant="ghost"
            iconOnly
            className={styles.close}
            aria-label={`Close ${title}`}
            disabled={onClose === null}
            onClick={() => onClose?.()}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        {children}
      </div>
    );
  }
  return (
    <>
      {desktop && anchorEl && container
        ? createPortal(
            <div
              id={panelId}
              ref={panel.ref}
              role="dialog"
              aria-label={title}
              className={styles.surface}
              style={panel.style}
            >
              {children}
            </div>,
            container,
          )
        : null}
      <MobileSheet
        active={active && !inline && isMobile}
        onDismiss={() => onClose?.()}
        onDismissRequest={() => (onClose === null ? "blocked" : "accepted")}
        ariaLabel={title}
        focusKey={focusKey}
        panelId={panelId}
        initialFocus={(sheet) => sheet}
        returnFocusTo={anchor}
        returnFocusFallback={returnFocusFallback}
        skipReturnFocus={skipReturnFocus}
      >
        {children}
      </MobileSheet>
    </>
  );
}
