"use client";

import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import styles from "./MobileFullScreenTask.module.css";
import { useMobileModalLifecycle } from "./useMobileModalLifecycle";

interface MobileFullScreenTaskProps {
  /** Stay mounted; gate behavior and portal rendering with active. */
  active: boolean;
  /** Called only after the dismissal request is accepted. */
  onDismiss(): void;
  /** Owns Back/Escape safety and may perform an internal pop. */
  onDismissRequest(): DismissDecision;
  ariaLabel: string;
  children: ReactNode;
  initialFocus(container: HTMLElement): HTMLElement | null;
  skipReturnFocus?: () => boolean;
  focusKey: unknown;
}

/**
 * Opaque, visual-viewport-sized mobile task presentation.
 *
 * The feature owns the task's header, content, scrolling, and state. This
 * primitive owns only modal lifecycle and the fixed full-screen frame.
 */
export default function MobileFullScreenTask({
  active,
  onDismiss,
  onDismissRequest,
  ariaLabel,
  children,
  initialFocus,
  skipReturnFocus,
  focusKey,
}: MobileFullScreenTaskProps) {
  const panelRef = useRef<HTMLElement>(null);
  const lifecycle = useMobileModalLifecycle({
    panelRef,
    active,
    onDismiss,
    onDismissRequest,
    initialFocus,
    skipReturnFocus,
    focusKey,
  });

  if (!active) return null;
  return createPortal(
    <ModalLayerProvider token={lifecycle.layerToken}>
      <div
        className={styles.projection}
        {...modalBackdropProjection(lifecycle.isTopmost)}
        role="presentation"
        style={{
          top: `${lifecycle.visualViewportTopPx}px`,
          bottom: `${lifecycle.keyboardBottomInsetPx}px`,
        }}
      >
        <section
          ref={panelRef}
          className={styles.frame}
          role="dialog"
          aria-label={ariaLabel}
          tabIndex={-1}
        >
          <div className={styles.content}>{children}</div>
        </section>
      </div>
    </ModalLayerProvider>,
    document.body,
  );
}
