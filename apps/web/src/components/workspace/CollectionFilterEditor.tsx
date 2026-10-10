"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./CollectionFilterEditor.module.css";

const FIELD =
  "input:not(:disabled), select:not(:disabled), button:not(:disabled)";

/**
 * A collection's facet editor: an anchored dialog on desktop, a sheet on
 * mobile, with Clear filters, Reset view and Done. A breakpoint change closes
 * it and returns focus to its trigger.
 */
export default function CollectionFilterEditor(props: {
  readonly activeCount: number;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly children: ReactNode;
  readonly onClearFilters: () => void;
  readonly onResetView?: () => void;
}) {
  const { activeCount, triggerRef, onResetView } = props;
  const isMobile = useIsMobileViewport();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const fieldsRef = useRef<HTMLDivElement>(null);
  const wasMobile = useRef(isMobile);
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (wasMobile.current === isMobile) return;
    wasMobile.current = isMobile;
    if (!open) return;
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, [isMobile, open, triggerRef]);
  useEffect(() => {
    if (!open || isMobile) return;
    const frame = requestAnimationFrame(() =>
      fieldsRef.current
        ?.querySelector<HTMLElement>(FIELD)
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [isMobile, open]);

  const content = (
    <div
      id={isMobile ? undefined : panelId}
      className={styles.editor}
      data-collection-filter-editor="true"
    >
      <div ref={fieldsRef} className={styles.fields}>
        {props.children}
      </div>
      <div className={styles.actions}>
        {activeCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const field =
                fieldsRef.current?.querySelector<HTMLElement>(FIELD) ??
                triggerRef.current;
              field?.focus({ preventScroll: true });
              props.onClearFilters();
            }}
          >
            Clear filters
          </Button>
        ) : null}
        {onResetView ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              close(true);
              onResetView();
            }}
          >
            Reset view
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={() => close(true)}>
          Done
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Button
        ref={triggerRef}
        variant={activeCount > 0 ? "secondary" : "ghost"}
        size="sm"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        Filters
        {activeCount > 0 ? (
          <span className={styles.badge}>{activeCount}</span>
        ) : null}
      </Button>
      <FloatingActionSurface
        open={open && !isMobile}
        anchor={triggerRef.current}
        placement="below"
        align="end"
        flip
        role="dialog"
        label="Filters"
        additionalDismissRefs={[triggerRef]}
        onDismiss={(reason) => close(reason === "escape")}
      >
        {isMobile ? null : content}
      </FloatingActionSurface>
      <MobileSheet
        active={open && isMobile}
        onDismiss={() => close(false)}
        ariaLabel="Filters"
        panelId={panelId}
        initialFocus={(container) =>
          container.querySelector<HTMLElement>(FIELD) ?? container
        }
        returnFocusTo={() => triggerRef.current}
      >
        {isMobile ? content : null}
      </MobileSheet>
    </>
  );
}
