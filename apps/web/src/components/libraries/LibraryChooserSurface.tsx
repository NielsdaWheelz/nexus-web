"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  onClose: () => void;
  /** Anchor element for positioning AND primary return focus. */
  anchor: ReturnFocusTarget;
  returnFocusFallback?: ReturnFocusTarget;
  /** Accessible name (mobile sheet and desktop panel). */
  title: string;
  /** Re-focus on session change (mobile sheet). */
  focusKey?: unknown;
  panelId?: string;
  /** The LibraryChooser. */
  children: ReactNode;
}

/**
 * The library chooser's presentation: on desktop an anchored panel below its
 * anchor (a transient layer: Escape, an outside press and, inside a modal,
 * Back close it); on phones the shared MobileSheet. Owns no chooser content:
 * the LibraryChooser child renders the combobox and keeps focus in it.
 */
export default function LibraryChooserSurface({
  active,
  onClose,
  anchor,
  returnFocusFallback,
  title,
  focusKey,
  panelId,
  children,
}: LibraryChooserSurfaceProps) {
  const isMobile = useIsMobileViewport();
  const desktop = active && !isMobile;
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
  useOverlay(desktop, {
    kind: "transient",
    onDismiss: onClose,
    inside: () => [panel.ref.current, anchorEl],
    returnFocus: true,
    returnFocusTo: anchor,
    returnFocusFallback,
  });

  // Focus the search once placed.
  useEffect(() => {
    if (!panel.placed) return;
    const frame = requestAnimationFrame(() =>
      panel.ref.current
        ?.querySelector<HTMLElement>('[role="combobox"]')
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [panel.placed, panel.ref]);

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
        active={active && isMobile}
        onDismiss={onClose}
        ariaLabel={title}
        focusKey={focusKey}
        panelId={panelId}
        initialFocus={(sheet) => sheet}
        returnFocusTo={anchor}
        returnFocusFallback={returnFocusFallback}
      >
        {children}
      </MobileSheet>
    </>
  );
}
