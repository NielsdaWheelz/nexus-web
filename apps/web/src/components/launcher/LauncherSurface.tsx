"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import {
  ModalLayerProvider,
  modalBackdropProjection,
} from "@/lib/ui/useModalLayer";
import type { LauncherController } from "./useLauncherController";
import AddPanel from "./AddPanel";
import AddPanelBoundary from "./AddPanelBoundary";
import CreatePanel from "./CreatePanel";
import LauncherFooter from "./LauncherFooter";
import LauncherInput from "./LauncherInput";
import LauncherLaneChips from "./LauncherLaneChips";
import LauncherList from "./LauncherList";
import styles from "./launcher.module.css";

export default function LauncherSurface({
  controller,
  activeAddDefect,
  onAddDefect,
  onClearAddDefect,
}: {
  controller: LauncherController;
  activeAddDefect: boolean;
  onAddDefect(error: unknown): void;
  onClearAddDefect(): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlay = useDialogOverlay({
    ref: panelRef,
    active: true,
    onDismiss: controller.escape,
    initialFocus: (container) => controller.initialFocus(container, false),
    // A command that navigates focuses its destination; don't restore the opener and
    // fight it. Dismissal (Escape/backdrop) keeps the default return-focus.
    skipReturnFocus: controller.shouldSuppressReturnFocusOnClose,
    focusKey: controller.focusKey,
  });

  return createPortal(
    <ModalLayerProvider token={overlay.layerToken}>
      <div
        className={styles.backdrop}
        {...modalBackdropProjection(overlay.isTopmost)}
        role="presentation"
        onClick={controller.close}
      >
        <div
          ref={panelRef}
          className={styles.surface}
          role="dialog"
          aria-label={
            activeAddDefect ? "Add needs attention" : controller.dialogLabel
          }
          onClick={(event) => event.stopPropagation()}
        >
          {controller.page.kind === "add" ? (
            <AddPanelBoundary
              activeDefect={activeAddDefect}
              resetKey={controller.addSession.state.sessionId}
              session={controller.addSession}
              controller={controller}
              onClearDefect={onClearAddDefect}
              onDefect={onAddDefect}
            >
              <AddPanel
                key={controller.addSession.state.sessionId}
                session={controller.addSession}
                dismissalConfirmation={controller.dismissalConfirmation}
                onOpen={controller.openAddTarget}
                onClose={controller.close}
                onBack={controller.back}
                onKeepWorking={controller.keepWorking}
                onConfirmDismissal={controller.confirmDismissal}
                onDefect={onAddDefect}
              />
            </AddPanelBoundary>
          ) : controller.page.kind === "create" ? (
            <CreatePanel
              onOpen={controller.openTarget}
              onClose={controller.close}
              onBack={controller.back}
            />
          ) : (
            <>
              <LauncherInput controller={controller} />
              {controller.page.kind === "root" ? (
                <LauncherLaneChips controller={controller} />
              ) : null}
              <LauncherList controller={controller} />
              <LauncherFooter controller={controller} />
            </>
          )}
        </div>
      </div>
    </ModalLayerProvider>,
    document.body,
  );
}
