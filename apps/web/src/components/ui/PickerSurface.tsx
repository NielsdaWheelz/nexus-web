"use client";

// Where a picker shows: on desktop a panel anchored beside its trigger
// (a transient layer: Escape, an outside press and, inside a modal, Back close
// it), on phones the shared MobileSheet. Inline, it is a region in the caller's
// layout instead: Escape and Back close it, an outside press does not (collapsing
// would move the control the press meant to reach). Content owns its semantics
// and initial focus; the surface owns placement and the existing overlay layer.

import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { FeedbackRecoveryControl } from "@/components/feedback/Feedback";
import FeedbackSurface from "@/components/feedback/FeedbackSurface";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import {
  OverlayContext,
  useOverlay,
  useOverlayContainer,
  wasOverlayInvokedByTouch,
  type ReturnFocusTarget,
} from "@/lib/ui/overlay";
import { useCollectionLayout } from "@/lib/ui/collection";
import collection from "./Collection.module.css";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./PickerSurface.module.css";

export default function PickerSurface({
  active,
  inline = false,
  onClose,
  anchor,
  returnFocusFallback,
  skipReturnFocus,
  title,
  focusKey,
  panelId,
  placement = "below",
  initialFocus,
  desktopRole = "dialog",
  heightLimit,
  className,
  children,
}: {
  readonly active: boolean;
  /** A region in the caller's layout, not the anchored panel or the sheet. */
  readonly inline?: boolean;
  readonly onClose: () => void;
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
  readonly placement?: "above" | "below";
  readonly initialFocus?: (panel: HTMLElement) => HTMLElement | null;
  /** A listbox supplies its own named root inside a neutral desktop shell. */
  readonly desktopRole?: "dialog" | null;
  /** Omit the preferred height ceiling; still fit beside the trigger. */
  readonly heightLimit?: "available";
  /** Desktop panel appearance; the mobile sheet keeps its own geometry. */
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const isMobile = useIsMobileViewport();
  const modal = useContext(OverlayContext);
  const [regionElement, setRegionElement] = useState<HTMLDivElement | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const region = active && inline;
  const desktop = active && !inline && !isMobile;
  const regionRef = useRef<HTMLDivElement>(null);
  const target = desktop ? anchor() : null;
  const anchorEl = target === null || target instanceof HTMLElement ? target : target.element;
  const panel = useAnchoredPosition<HTMLDivElement>(anchorEl, {
    enabled: desktop,
    placement,
    align: "start",
    flip: true,
    keepAnchorVisible: true,
  });
  const bindRegion = useCallback((element: HTMLDivElement | null) => { regionRef.current = element; setRegionElement(element); }, []);
  const bindPanel = useCallback((element: HTMLDivElement | null) => { panel.ref.current = element; setPanelElement(element); }, [panel.ref]);
  useCollectionLayout(regionRef, region);
  useCollectionLayout(panel.ref, desktop);
  const select = useRef(initialFocus);
  select.current = initialFocus;
  const container = useOverlayContainer();
  const { layer } = useOverlay(desktop || region, {
    kind: "transient",
    onDismiss: onClose,
    inside: region ? undefined : () => [panel.ref.current, anchorEl],
    returnFocus: true,
    returnFocusTo: anchor,
    returnFocusFallback,
    skipReturnFocus,
    tabContinuation: () => region ? regionRef.current : panel.ref.current,
  });
  useEffect(() => {
    if (!desktop || !panel.placed) return;
    const frame = requestAnimationFrame(() => {
      const target = panel.ref.current;
      if (target) (select.current?.(target) ?? target.querySelector<HTMLInputElement>("input") ?? target).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [desktop, panel.placed, panel.ref]);
  useEffect(() => {
    if (!region) return;
    const focusSearch = !wasOverlayInvokedByTouch();
    const frame = requestAnimationFrame(() => {
      const target = regionRef.current;
      if (target) (select.current?.(target) ?? (focusSearch ? target.querySelector<HTMLInputElement>("input") ?? target : target)).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [region, focusKey]);

  if (region) {
    return (
      <div
        id={panelId}
        ref={bindRegion}
        role="region"
        aria-label={title}
        tabIndex={-1}
        className={`${collection.surface} ${styles.inline}`}
      >
        <FeedbackSurface bounds={regionElement} interaction={layer} modal={modal} active={region}
          protectedTargets={() => regionRef.current ? [...regionRef.current.querySelectorAll<HTMLElement>("header, [data-feedback-controls]")] : []} returnFocus={() => regionRef.current}>
        <div className={styles.header} data-feedback-controls="true">
          <h3 className={styles.title}>{title}</h3>
          <FeedbackRecoveryControl />
          <Button
            iconOnly
            icon={<X />}
            className={styles.close}
            aria-label={`close ${title}`}
            onClick={onClose}
          />
        </div>
        {children}
        </FeedbackSurface>
      </div>
    );
  }
  return (
    <>
      {desktop && anchorEl && container
        ? createPortal(
            <div
              id={panelId}
              ref={bindPanel}
              role={desktopRole ?? undefined}
              aria-label={desktopRole ? title : undefined}
              tabIndex={desktopRole ? -1 : undefined}
              className={[collection.surface, styles.surface, heightLimit === "available" && styles.available, className].filter(Boolean).join(" ")}
              style={panel.style}
            >
              <FeedbackSurface bounds={panelElement} interaction={layer} modal={modal} active={desktop}
                protectedTargets={() => anchorEl ? [anchorEl] : []} returnFocus={() => panel.ref.current}>
                <span className={styles.recoverySlot}><FeedbackRecoveryControl /></span>
                {children}
              </FeedbackSurface>
            </div>,
            container,
          )
        : null}
      <MobileSheet
        active={active && !inline && isMobile}
        onDismiss={onClose}
        ariaLabel={title}
        focusKey={focusKey}
        panelId={panelId}
        initialFocus={(sheet) => select.current?.(sheet) ?? (wasOverlayInvokedByTouch() ? sheet : sheet.querySelector<HTMLInputElement>("input") ?? sheet)}
        returnFocusTo={anchor}
        returnFocusFallback={returnFocusFallback}
        skipReturnFocus={skipReturnFocus}
        heightLimit={heightLimit}
      >
        {children}
      </MobileSheet>
    </>
  );
}
