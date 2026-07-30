"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import DesktopNexusActionsPage from "./DesktopNexusActionsPage";
import DesktopNexusInput from "./DesktopNexusInput";
import DesktopNexusResults from "./DesktopNexusResults";
import type { DesktopNexusController } from "./types";
import styles from "./desktopNexus.module.css";

export default function DesktopNexus({
  controller,
}: {
  controller: DesktopNexusController;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlay = useDialogOverlay({
    ref: panelRef,
    active: controller.open,
    onDismiss: controller.escape,
    initialFocus: (container) => {
      if (controller.workflow) {
        return container.querySelector<HTMLElement>(
          "[data-nexus-workflow-initial-focus]",
        );
      }
      if (controller.page.kind === "Actions") {
        return container.querySelector<HTMLElement>('[role="menuitem"]');
      }
      return container.querySelector<HTMLElement>('input[role="combobox"]');
    },
    skipReturnFocus: controller.shouldSuppressReturnFocusOnClose,
    focusKey: controller.focusKey,
    layerScope: "nexus",
  });

  if (!controller.open) return null;
  const actionsAvailable =
    controller.page.kind !== "Actions" &&
    controller.entries.some(
      (entry) =>
        entry.key === controller.activeEntryKey && entry.hasSecondaryActions,
    );
  const selectedLabel = controller.entries.find(
    (entry) => entry.key === controller.activeEntryKey,
  )?.label;

  return createPortal(
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.backdrop}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
        onClick={controller.escape}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Nexus"
          className={styles.surface}
          onClick={(event) => event.stopPropagation()}
        >
          {controller.workflow ? (
            controller.workflow
          ) : controller.page.kind === "Actions" ? (
            <DesktopNexusActionsPage controller={controller} />
          ) : (
            <>
              <h2 className="sr-only">Nexus</h2>
              <DesktopNexusInput controller={controller} />
              <DesktopNexusResults controller={controller} />
              <footer className={styles.footer}>
                <span className={styles.keyHint}>
                  <kbd>↩</kbd> Open
                </span>
                <span className={styles.keyHint}>
                  <kbd>⇧↩</kbd> New tab
                </span>
                {actionsAvailable ? (
                  <button
                    type="button"
                    className={styles.actionsButton}
                    onClick={controller.openActions}
                    aria-label={`Actions for ${selectedLabel}`}
                  >
                    <MoreHorizontal size={16} aria-hidden="true" />
                    Actions
                  </button>
                ) : null}
              </footer>
            </>
          )}
        </div>
      </div>
    </ModalLayerProvider>,
    document.body,
  );
}
