"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useOverlay, useOverlayContainer } from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import ModalFrame from "./ModalFrame";
import styles from "./HoverPreview.module.css";

const DELAY_MS = 150;

/**
 * A preview of the element `trigger` is spread on. Hovering with a mouse or
 * pen, or focusing from the keyboard, opens a card above it after 150 ms;
 * leaving the element closes it 150 ms later unless the pointer reaches the
 * card. A press on the element, Escape, a press outside and focus moving away
 * close it too. `show` opens at once; on a touch screen the preview is a modal
 * bottom sheet, which Back closes.
 */
export function useHoverPreview(enabled: boolean, label: string): {
  readonly trigger: {
    onPointerEnter(event: PointerEvent<HTMLElement>): void;
    onPointerLeave(event: PointerEvent<HTMLElement>): void;
    onPointerDown(): void;
    onFocus(event: FocusEvent<HTMLElement>): void;
    onBlur(event: FocusEvent<HTMLElement>): void;
  };
  show(anchor: HTMLElement, focus?: boolean): void;
  close(options?: { restoreFocus?: boolean }): void;
  render(body: ReactNode): ReactNode;
} {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const skipReturnFocus = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const focusNext = useRef(false);
  const later = (run: () => void) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, DELAY_MS);
  };
  const close = useCallback((options?: { restoreFocus?: boolean }) => {
    skipReturnFocus.current = options?.restoreFocus === false;
    window.clearTimeout(timer.current);
    setAnchor(null);
  }, []);
  useLayoutEffect(() => { if (!enabled) close(); }, [enabled, close]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const open = (element: HTMLElement) => {
    if (enabled) later(() => { skipReturnFocus.current = false; setAnchor(element); });
  };

  // Read only once open, after an interaction: the server never renders one.
  const touch = anchor !== null && matchMedia("(hover: none)").matches;
  const card = enabled && anchor !== null && !touch;
  const position = useAnchoredPosition<HTMLDivElement>(anchor, {
    enabled: card,
    placement: "above",
    align: "center",
    gap: 8,
    flip: true,
  });
  const container = useOverlayContainer();
  useLayoutEffect(() => {
    if (!anchor || !position.placed || !focusNext.current) return;
    focusNext.current = false;
    position.ref.current?.querySelector<HTMLElement>("[data-row-focusable]")?.focus({ preventScroll: true });
  }, [anchor, position.placed, position.ref]);
  useOverlay(card, {
    kind: "transient",
    onDismiss: () => close(),
    inside: () => [position.ref.current, anchor],
    returnFocusTo: () => anchor,
    tabContinuation: () => position.ref.current,
  });

  return {
    trigger: {
      onPointerEnter: (event) => {
        if (event.pointerType !== "touch") open(event.currentTarget);
      },
      onPointerLeave: (event) => {
        if (event.pointerType !== "touch") later(close);
      },
      onPointerDown: () => close(),
      onFocus: (event) => {
        if (event.currentTarget.matches(":focus-visible")) {
          open(event.currentTarget);
        }
      },
      onBlur: (event) => {
        const next = event.relatedTarget as Node | null;
        if (!touch && !position.ref.current?.contains(next)) close();
      },
    },
    show: (element, focus = false) => {
      focusNext.current = focus;
      if (!enabled) return;
      skipReturnFocus.current = false;
      if (focus && anchor === element && position.placed) {
        focusNext.current = false;
        position.ref.current?.querySelector<HTMLElement>("[data-row-focusable]")?.focus({ preventScroll: true });
      } else setAnchor(element);
    },
    close,
    render: (body) =>
      !enabled || anchor === null ? null : touch ? (
        <ModalFrame
          open
          onDismiss={() => close()}
          skipReturnFocus={() => !enabledRef.current || skipReturnFocus.current}
          label={label}
          backdropClassName={styles.sheetBackdrop}
          className={styles.sheet}
        >
          {body}
        </ModalFrame>
      ) : container ? (
        createPortal(
          <div
            ref={position.ref}
            className={styles.card}
            role="dialog"
            aria-label={label}
            style={position.style}
            onPointerEnter={() => window.clearTimeout(timer.current)}
            onPointerLeave={() => later(() => {
              const preview = position.ref.current;
              if (!preview?.contains(document.activeElement) && !preview?.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')) close();
            })}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              // Focus synchronously schedules opening; close cancels that timer.
              anchor.focus({ preventScroll: true });
              close();
            }}
          >
            {body}
          </div>,
          container,
        )
      ) : null,
  };
}
