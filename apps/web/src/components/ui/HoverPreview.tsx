"use client";

import {
  useCallback,
  useEffect,
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
export function useHoverPreview(enabled: boolean): {
  readonly trigger: {
    onPointerEnter(event: PointerEvent<HTMLElement>): void;
    onPointerLeave(): void;
    onPointerDown(): void;
    onFocus(event: FocusEvent<HTMLElement>): void;
    onBlur(event: FocusEvent<HTMLElement>): void;
  };
  show(anchor: HTMLElement): void;
  close(): void;
  render(body: ReactNode): ReactNode;
} {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const later = (run: () => void) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, DELAY_MS);
  };
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const open = (element: HTMLElement) => {
    if (enabled) later(() => setAnchor(element));
  };

  // Read only once open, after an interaction: the server never renders one.
  const touch = anchor !== null && matchMedia("(hover: none)").matches;
  const card = anchor !== null && !touch;
  const position = useAnchoredPosition<HTMLDivElement>(anchor, {
    enabled: card,
    placement: "above",
    align: "center",
    gap: 8,
    flip: true,
  });
  const container = useOverlayContainer();
  useOverlay(card, {
    kind: "transient",
    onDismiss: close,
    inside: () => [position.ref.current, anchor],
  });

  return {
    trigger: {
      onPointerEnter: (event) => {
        if (event.pointerType !== "touch") open(event.currentTarget);
      },
      onPointerLeave: () => later(close),
      onPointerDown: close,
      onFocus: (event) => {
        if (event.currentTarget.matches(":focus-visible")) {
          open(event.currentTarget);
        }
      },
      onBlur: (event) => {
        const next = event.relatedTarget as Node | null;
        if (!position.ref.current?.contains(next)) close();
      },
    },
    show: (element) => {
      if (enabled) setAnchor(element);
    },
    close,
    render: (body) =>
      anchor === null ? null : touch ? (
        <ModalFrame
          open
          onDismiss={close}
          label="Preview"
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
            role="tooltip"
            style={position.style}
            onPointerEnter={() => window.clearTimeout(timer.current)}
            onPointerLeave={() => later(close)}
          >
            {body}
          </div>,
          container,
        )
      ) : null,
  };
}
