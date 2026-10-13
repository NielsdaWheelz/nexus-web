"use client";

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
import styles from "./LibraryChooserSurface.module.css";

export interface LibraryChooserSurfaceProps {
  /** Render/behaviour gate. */
  active: boolean;
  presentation: "Responsive" | "Inline";
  /** null locks dismissal while the caller completes creation. */
  onClose: (() => void) | null;
  /** Anchor element for positioning AND primary return focus. */
  anchor: ReturnFocusTarget;
  returnFocusFallback?: ReturnFocusTarget;
  skipReturnFocus?: () => boolean;
  /** Accessible name (mobile sheet and desktop panel). */
  title: string;
  /** Re-focus on session change (mobile sheet). */
  focusKey?: unknown;
  panelId?: string;
  /** The LibraryChooser. */
  children: ReactNode;
}

/**
 * Responsive keeps the anchored desktop panel and mobile sheet. Inline stays
 * in the caller's layout; an outside press must not collapse it before the
 * intended click lands. Both use the existing Escape/Back/focus contract.
 */
export default function LibraryChooserSurface({
  active,
  presentation,
  onClose,
  anchor,
  returnFocusFallback,
  skipReturnFocus,
  title,
  focusKey,
  panelId,
  children,
}: LibraryChooserSurfaceProps) {
  const isMobile = useIsMobileViewport();
  const inline = active && presentation === "Inline";
  const desktop = active && presentation === "Responsive" && !isMobile;
  const inlineRef = useRef<HTMLDivElement>(null);
  const target = desktop ? anchor() : null;
  const anchorEl =
    target === null || target instanceof HTMLElement ? target : target.element;
  const panel = useAnchoredPosition<HTMLDivElement>(anchorEl, {
    enabled: desktop,
    placement: "below",
    align: "start",
    flip: true,
  });
  const container = useOverlayContainer();
  useOverlay(desktop || inline, {
    kind: "transient",
    onDismiss: () => onClose?.(),
    inside: inline ? undefined : () => [panel.ref.current, anchorEl],
    returnFocus: true,
    returnFocusTo: anchor,
    returnFocusFallback,
    skipReturnFocus,
  });

  // Focus the search once placed.
  useEffect(() => {
    if (!desktop || !panel.placed) return;
    const frame = requestAnimationFrame(() =>
      panel.ref.current
        ?.querySelector<HTMLInputElement>("input")
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [desktop, panel.placed, panel.ref]);

  useEffect(() => {
    if (!inline) return;
    // Opening a region should not summon the phone's keyboard unasked.
    const frame = requestAnimationFrame(() => inlineRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [inline, focusKey]);

  if (inline) {
    return (
      <div
        id={panelId}
        ref={inlineRef}
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
              className={styles.surface}
              style={panel.style}
              aria-label={title}
            >
              {children}
            </div>,
            container,
          )
        : null}
      <MobileSheet
        active={active && presentation === "Responsive" && isMobile}
        onDismiss={() => onClose?.()}
        onDismissRequest={() => onClose === null ? "blocked" : "accepted"}
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
