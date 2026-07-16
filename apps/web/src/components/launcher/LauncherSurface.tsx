"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import type { LauncherController } from "./useLauncherController";
import AddPanel from "./AddPanel";
import CreatePanel from "./CreatePanel";
import LauncherFooter from "./LauncherFooter";
import LauncherInput from "./LauncherInput";
import LauncherLaneChips from "./LauncherLaneChips";
import LauncherList from "./LauncherList";
import styles from "./launcher.module.css";

export default function LauncherSurface({ controller }: { controller: LauncherController }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogOverlay({
    ref: panelRef,
    active: true,
    onDismiss: () => (controller.page.kind === "root" ? controller.close() : controller.back()),
    initialFocus: (container) => container.querySelector<HTMLElement>('[role="combobox"]'),
    // A command that navigates focuses its destination; don't restore the opener and
    // fight it. Dismissal (Escape/backdrop) keeps the default return-focus.
    skipReturnFocus: controller.shouldSuppressReturnFocusOnClose,
    focusKey: controller.page.kind,
  });

  return createPortal(
    <div className={styles.backdrop} role="presentation" onClick={controller.close}>
      <div
        ref={panelRef}
        className={styles.surface}
        role="dialog"
        aria-modal="true"
        aria-label="Launcher"
        onClick={(event) => event.stopPropagation()}
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
            <LauncherInput controller={controller} />
            {controller.page.kind === "root" ? <LauncherLaneChips controller={controller} /> : null}
            <LauncherList controller={controller} />
            <LauncherFooter controller={controller} />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
