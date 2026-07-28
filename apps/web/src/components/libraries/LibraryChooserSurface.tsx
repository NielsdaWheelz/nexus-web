"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import MobileSheet from "@/components/ui/MobileSheet";
import { resolveTransientPortalContainer } from "@/lib/ui/transientPortalContainer";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { useHistoryDismiss } from "@/lib/ui/useHistoryDismiss";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  useContainingModalLayer,
  useIsModalLayerTopmost,
} from "@/lib/ui/useModalLayer";
import { useReturnFocus, type ReturnFocusTarget } from "@/lib/ui/useReturnFocus";
import styles from "./LibraryChooserSurface.module.css";

export interface LibraryChooserSurfaceProps {
  /** Render/behavior gate. Keep the component mounted; drive it with this. */
  active: boolean;
  onClose: () => void;
  /** Mobile sheet layer token + desktop stacking. No default/inference. */
  layer: "modal" | "palette";
  /** Anchor element for positioning AND primary return focus. */
  anchor: ReturnFocusTarget;
  returnFocusFallback?: ReturnFocusTarget;
  /** Accessible name (mobile sheet aria-label; desktop panel aria-label). */
  title: string;
  /** Forwarded to MobileSheet (re-focus on session change). */
  focusKey?: unknown;
  /** Stable test id for the mobile sheet panel. */
  panelTestId?: string;
  /** The LibraryChooser. */
  children: ReactNode;
}

/**
 * The responsive placement/portal/dismissal/focus owner for the library chooser
 * (docs/cutovers/library-chooser-interaction-hard-cutover.md §6). Desktop mirrors
 * the ActionMenu anchored-popover trio (useAnchoredPosition +
 * useDismissOnOutsideOrEscape + useHistoryDismiss/useReturnFocus, portaled via the
 * shared transient-portal-container rule); mobile reuses the existing MobileSheet.
 * It owns no chooser content — `children` (the LibraryChooser) renders the
 * combobox/listbox and keeps DOM focus on the search input.
 */
export default function LibraryChooserSurface({
  active,
  onClose,
  layer,
  anchor,
  returnFocusFallback,
  title,
  focusKey,
  panelTestId,
  children,
}: LibraryChooserSurfaceProps) {
  const isMobile = useIsMobileViewport();
  const modalToken = useContainingModalLayer();
  const modalIsTopmost = useIsModalLayerTopmost(modalToken);
  const desktopActive = active && !isMobile;

  // The live anchor element, resolved each render, drives both positioning and
  // the dismiss refs (a pointerdown on the trigger must not read as "outside").
  const anchorEl = desktopActive ? anchor() : null;
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = anchorEl;

  const {
    ref: panelRef,
    style,
    anchorRect,
  } = useAnchoredPosition<HTMLDivElement>(anchorEl, {
    enabled: desktopActive,
    placement: "below",
    align: "start",
    gap: 4,
    flip: true,
  });

  useDismissOnOutsideOrEscape({
    enabled: desktopActive,
    refs: [panelRef, anchorRef],
    onDismiss: () => onClose(),
  });

  // History entry only for a modal-contained desktop chooser; a base-page desktop
  // chooser adds none (spec §3). MobileSheet owns mobile Back on its own.
  useHistoryDismiss(
    desktopActive && modalToken !== null,
    () => {
      onClose();
      return "accepted";
    },
    { isTopmost: modalIsTopmost },
  );

  useReturnFocus(desktopActive, {
    returnFocusTo: anchor,
    returnFocusFallback,
  });

  // Focus search on open, once positioned (anchorRect is set after the first
  // measure). The child LibraryChooser renders the combobox.
  useEffect(() => {
    if (!desktopActive || !anchorRect) return;
    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>('[role="combobox"]')
        ?.focus();
    });
  }, [desktopActive, anchorRect, panelRef]);

  const desktopPanel =
    desktopActive && anchorEl && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            className={styles.surface}
            style={style}
            data-layer={layer}
            aria-label={title}
          >
            {children}
          </div>,
          resolveTransientPortalContainer(anchorEl, modalToken !== null),
        )
      : null;

  return (
    <>
      {desktopPanel}
      <MobileSheet
        active={active && isMobile}
        onDismiss={onClose}
        layer={layer}
        ariaLabel={title}
        focusKey={focusKey}
        panelTestId={panelTestId}
        initialFocus={(container) => container}
        returnFocusTo={anchor}
        returnFocusFallback={returnFocusFallback}
      >
        {children}
      </MobileSheet>
    </>
  );
}
