"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import type { PaletteController } from "./usePaletteController";
import PaletteInput from "./PaletteInput";
import PaletteList from "./PaletteList";
import PaletteFooter from "./PaletteFooter";
import styles from "./palette.module.css";

export default function PaletteSurface({ controller }: { controller: PaletteController }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogOverlay({
    ref: panelRef,
    active: true,
    onDismiss: () => (controller.page.kind === "actions" ? controller.back() : controller.close()),
    initialFocus: (container) => container.querySelector<HTMLElement>('[role="combobox"]'),
    focusKey: controller.page.kind,
  });

  return createPortal(
    <div className={styles.backdrop} role="presentation" onClick={controller.close}>
      <div
        ref={panelRef}
        className={styles.surface}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <PaletteInput controller={controller} />
        <PaletteList controller={controller} />
        <PaletteFooter controller={controller} />
      </div>
    </div>,
    document.body,
  );
}
