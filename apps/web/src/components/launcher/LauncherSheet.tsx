"use client";

import MobileSheet from "@/components/ui/MobileSheet";
import type { LauncherController } from "./useLauncherController";
import AddPanel from "./AddPanel";
import CreatePanel from "./CreatePanel";
import LauncherInput from "./LauncherInput";
import LauncherLaneChips from "./LauncherLaneChips";
import LauncherList from "./LauncherList";
import styles from "./launcher.module.css";

export default function LauncherSheet({
  controller,
  active,
}: {
  controller: LauncherController;
  active: boolean;
}) {
  return (
    <MobileSheet
      active={active}
      onDismiss={controller.close}
      // Escape pops a level on a sub-page; every full-dismiss path (backdrop, drag, back) → close.
      onEscape={() => (controller.page.kind === "root" ? controller.close() : controller.back())}
      ariaLabel="Launcher"
      layer="palette"
      panelClassName={styles.sheetSkin}
      initialFocus={(container) => container.querySelector<HTMLElement>('[role="combobox"]')}
      focusKey={controller.page.kind}
    >
      {controller.page.kind === "add" ? (
        <AddPanel
          seed={controller.page.seed}
          onOpen={controller.openTarget}
          onClose={controller.close}
          onBack={controller.back}
        />
      ) : controller.page.kind === "create" ? (
        <CreatePanel onOpen={controller.openTarget} onClose={controller.close} onBack={controller.back} />
      ) : (
        <>
          <LauncherList controller={controller} />
          {controller.page.kind === "root" ? <LauncherLaneChips controller={controller} /> : null}
          <LauncherInput controller={controller} />
        </>
      )}
    </MobileSheet>
  );
}
