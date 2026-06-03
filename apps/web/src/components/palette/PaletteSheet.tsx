"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import { useKeyboardInset } from "@/lib/ui/useKeyboardInset";
import type { PaletteController } from "./usePaletteController";
import PaletteInput from "./PaletteInput";
import PaletteList from "./PaletteList";
import styles from "./palette.module.css";

const DRAG_DISMISS_PX = 96;

export default function PaletteSheet({ controller }: { controller: PaletteController }) {
  const panelRef = useRef<HTMLElement>(null);
  const dragStartRef = useRef<number | null>(null);
  const inset = useKeyboardInset();

  useDialogOverlay({
    ref: panelRef,
    active: true,
    onDismiss: () => (controller.page.kind === "actions" ? controller.back() : controller.close()),
    initialFocus: (container) => container.querySelector<HTMLElement>('[role="combobox"]'),
    focusKey: controller.page.kind,
  });

  function onPointerDown(event: React.PointerEvent) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!(event.target instanceof Element) || !event.target.closest("[data-grabber]")) return;
    event.currentTarget.setPointerCapture(event.pointerId); // keep move/up even if the flick leaves the sheet
    dragStartRef.current = event.clientY;
  }
  function onPointerMove(event: React.PointerEvent) {
    if (dragStartRef.current === null || !panelRef.current) return;
    panelRef.current.style.transform = `translateY(${Math.max(0, event.clientY - dragStartRef.current)}px)`;
  }
  function onPointerUp(event: React.PointerEvent) {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (start === null || !panelRef.current) return;
    panelRef.current.style.transform = "";
    if (event.clientY - start > DRAG_DISMISS_PX) controller.close();
  }

  return createPortal(
    <div className={styles.backdrop} data-variant="sheet" role="presentation" onClick={controller.close}>
      <section
        ref={panelRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{ bottom: inset }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className={styles.grabber} data-grabber aria-hidden="true" />
        <PaletteList controller={controller} />
        <PaletteInput controller={controller} />
      </section>
    </div>,
    document.body,
  );
}
