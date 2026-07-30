"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import NexusButton from "@/components/switchboard/NexusButton";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import SwitchboardRecovery from "@/components/switchboard/SwitchboardRecovery";
import SwitchboardRoot from "@/components/switchboard/SwitchboardRoot";
import SwitchboardSheet from "@/components/switchboard/SwitchboardSheet";
import { paneStatusLabel } from "@/lib/switchboard/paneStatusLabel";
import { useViewportState } from "@/lib/renderEnvironment/provider";
import AddPanel from "./AddPanel";
import AddPanelBoundary from "./AddPanelBoundary";
import DesktopNexus from "./desktop/DesktopNexus";
import TodayCapturePanel from "./TodayCapturePanel";
import {
  useNexusController,
  type NexusController,
} from "./useNexusController";
import styles from "./Nexus.module.css";

function desktopWorkflow(input: {
  controller: NexusController;
  activeAddDefect: boolean;
  onAddDefect(error: unknown): void;
  onClearAddDefect(): void;
}): ReactNode {
  const {
    controller,
    activeAddDefect,
    onAddDefect,
    onClearAddDefect,
  } = input;
  const page = controller.page;
  let content: ReactNode;
  switch (page.kind) {
    case "Root":
    case "Find":
    case "Actions":
      return undefined;
    case "UnsupportedLink":
      content = (
        <section>
          <h2>This link is no longer supported</h2>
          <button
            type="button"
            onClick={() =>
              controller.openTarget({
                kind: "InternalHref",
                href: "/browse",
                labelHint: "Browse",
              })
            }
          >
            Open Browse
          </button>
        </section>
      );
      break;
    case "TodayCapture":
      content = (
        <TodayCapturePanel
          session={controller.todaySession}
          onOpen={controller.openTarget}
          onBack={controller.back}
        />
      );
      break;
    case "CreatePage":
      content = (
        <section>
          <h2>New page</h2>
          <p>
            {page.submit.kind === "Retryable"
              ? "Couldn’t create page."
              : "Creating page…"}
          </p>
          {page.submit.kind === "Retryable" ? (
            <button type="button" onClick={controller.retryPageCreation}>
              Retry
            </button>
          ) : null}
        </section>
      );
      break;
    case "CreateLibrary":
      content = (
        <CreateLibraryPanel
          name={page.nameDraft}
          submit={page.submit}
          onName={controller.setLibraryNameDraft}
          onBack={controller.back}
          onSubmit={controller.submitLibrary}
        />
      );
      break;
    case "Add":
      content = (
        <AddPanelBoundary
          activeDefect={activeAddDefect}
          resetKey={page.sessionId}
          session={controller.addSession}
          controller={controller}
          onClearDefect={onClearAddDefect}
          onDefect={onAddDefect}
        >
          <AddPanel
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
      );
      break;
    case "ActivationBlocked":
      content = (
        <SwitchboardRecovery
          retained={page.retained}
          onManageTabs={controller.manageTabs}
          onOpen={controller.retryRetainedActivation}
          onCancel={controller.cancelRetainedActivation}
        />
      );
      break;
    case "ManageTabs":
      content = (
        <SwitchboardRoot
          places={[]}
          quickActions={[]}
          panes={controller.switchboardPanes.map((pane) => ({
            id: pane.id,
            label: pane.label,
            metadata: paneStatusLabel(pane),
            current: pane.current,
            activationRouteId: pane.activationRouteId,
          }))}
          recentlyClosed={controller.switchboardClosedPanes.map((pane) => ({
            id: pane.id,
            label: pane.label,
            metadata: "Closed tab",
          }))}
          accountMenu={null}
          retainedTarget={
            page.retained.target.labelHint ?? page.retained.target.href
          }
          manageTabs
          onDone={controller.close}
          onFind={controller.enterFind}
          onPlace={controller.openSwitchboardPlace}
          onQuickAction={controller.runSwitchboardQuickAction}
          onOpenPane={(paneId) => {
            const pane = controller.switchboardPanes.find(
              (candidate) => candidate.id === paneId,
            );
            if (!pane) throw new Error(`Unknown Nexus pane: ${paneId}`);
            controller.openSwitchboardItem(
              {
                kind: "OpenPane",
                paneId,
                activationRouteId: pane.activationRouteId,
              },
              false,
            );
          }}
          onClosePane={controller.closeSwitchboardPane}
          onRestorePane={controller.restoreSwitchboardPane}
          onRetryRetained={controller.retryRetainedActivation}
          onCancelRetained={controller.cancelRetainedActivation}
        />
      );
      break;
  }
  return (
    <div
      className={styles.desktopWorkflow}
      data-nexus-workflow-initial-focus
      tabIndex={-1}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return;
        const target = controller.initialFocus(
          event.currentTarget,
          false,
        );
        if (target && target !== event.currentTarget) target.focus();
      }}
    >
      {content}
    </div>
  );
}

export default function Nexus() {
  const controller = useNexusController();
  const sessionId = controller.addSession.state.sessionId;
  const [addDefect, setAddDefect] = useState<{
    sessionId: string;
    error: unknown;
  } | null>(null);
  const reportAddDefect = useCallback(
    (error: unknown) => {
      console.error("Add content contract failed:", error);
      setAddDefect({ sessionId, error });
    },
    [sessionId],
  );
  const clearAddDefect = useCallback(() => setAddDefect(null), []);
  const viewport = useViewportState();
  const isMobile = viewport.isMobile;
  const waitingForViewport = controller.open && !viewport.hydrated;
  const workflow = desktopWorkflow({
    controller,
    activeAddDefect: addDefect?.sessionId === sessionId,
    onAddDefect: reportAddDefect,
    onClearAddDefect: clearAddDefect,
  });
  const desktopController = useMemo(
    () => ({ ...controller.desktop, workflow }),
    [controller.desktop, workflow],
  );

  return (
    <>
      <SwitchboardSheet
        controller={controller}
        active={controller.open && isMobile}
        activeAddDefect={addDefect?.sessionId === sessionId}
        onAddDefect={reportAddDefect}
        onClearAddDefect={clearAddDefect}
      />
      {isMobile && !waitingForViewport ? (
        <NexusButton
          paneCount={controller.paneCount}
          switchboardOpen={controller.open}
          onOpen={controller.openRoot}
        />
      ) : null}
      {!isMobile && !waitingForViewport ? (
        <DesktopNexus controller={desktopController} />
      ) : null}
    </>
  );
}
