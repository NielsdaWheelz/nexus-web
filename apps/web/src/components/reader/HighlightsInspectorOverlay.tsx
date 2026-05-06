"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import styles from "./HighlightsInspectorOverlay.module.css";

interface HighlightsInspectorOverlayProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function HighlightsInspectorOverlay({
  open,
  onClose,
  children,
}: HighlightsInspectorOverlayProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Esc closes; focus management on open/close.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    // Move focus into the panel after mount.
    const focusFrame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable) {
        focusable.focus();
        return;
      }
      panel.focus();
    });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(focusFrame);
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus();
      }
      previouslyFocusedRef.current = null;
    };
  }, [open, onClose]);

  const handleBackdropClick = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <>
      <div
        className={styles.backdrop}
        onClick={handleBackdropClick}
        data-testid="highlights-inspector-backdrop"
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Highlights inspector"
        tabIndex={-1}
        data-testid="highlights-inspector-panel"
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Highlights</h2>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close highlights"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </header>
        <div className={styles.body}>{children}</div>
      </aside>
    </>
  );
}
