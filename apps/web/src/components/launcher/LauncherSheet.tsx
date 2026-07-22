"use client";

import MobileSheet from "@/components/ui/MobileSheet";
import type { LauncherController } from "./useLauncherController";
import AddPanel from "./AddPanel";
import AddPanelBoundary from "./AddPanelBoundary";
import CreatePanel from "./CreatePanel";
import LauncherInput from "./LauncherInput";
import LauncherLaneChips from "./LauncherLaneChips";
import LauncherList from "./LauncherList";
import styles from "./launcher.module.css";

export default function LauncherSheet({
  controller,
  active,
  activeAddDefect,
  onAddDefect,
  onClearAddDefect,
}: {
  controller: LauncherController;
  active: boolean;
  activeAddDefect: boolean;
  onAddDefect(error: unknown): void;
  onClearAddDefect(): void;
}) {
  return (
    <MobileSheet
      active={active}
      onDismiss={controller.dismissAccepted}
      onDismissRequest={controller.guardClose}
      onEscape={controller.escape}
      ariaLabel={
        activeAddDefect ? "Add needs attention" : controller.dialogLabel
      }
      layer="palette"
      panelClassName={styles.sheetSkin}
      initialFocus={(container) => controller.initialFocus(container, true)}
      skipReturnFocus={controller.shouldSuppressReturnFocusOnClose}
      focusKey={controller.focusKey}
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
          <LauncherList controller={controller} />
          {controller.page.kind === "root" ? (
            <LauncherLaneChips controller={controller} />
          ) : null}
          <LauncherInput controller={controller} />
        </>
      )}
    </MobileSheet>
  );
}
