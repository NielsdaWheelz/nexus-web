"use client";

import MobileSheet from "@/components/ui/MobileSheet";
import type { PaletteController } from "./usePaletteController";
import PaletteInput from "./PaletteInput";
import PaletteList from "./PaletteList";
import styles from "./palette.module.css";

export default function PaletteSheet({
  controller,
  active,
}: {
  controller: PaletteController;
  active: boolean;
}) {
  return (
    <MobileSheet
      active={active}
      onDismiss={controller.close}
      // Escape pops a level on the actions page; every full-dismiss path
      // (backdrop tap, drag, back button) goes through onDismiss → close.
      onEscape={() => (controller.page.kind === "actions" ? controller.back() : controller.close())}
      ariaLabel="Command palette"
      layer="palette"
      panelClassName={styles.sheetSkin}
      initialFocus={(container) => container.querySelector<HTMLElement>('[role="combobox"]')}
      focusKey={controller.page.kind}
    >
      <PaletteList controller={controller} />
      <PaletteInput controller={controller} />
    </MobileSheet>
  );
}
