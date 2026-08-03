"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import NexusButton from "@/components/switchboard/NexusButton";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import SwitchboardRecovery from "@/components/switchboard/SwitchboardRecovery";
import SwitchboardTask from "@/components/switchboard/SwitchboardTask";
import { useViewportState } from "@/lib/renderEnvironment/provider";
import AddPanel from "./AddPanel";
import AddPanelBoundary from "./AddPanelBoundary";
import ChooseBrowsePage from "./ChooseBrowsePage";
import ChooseCreatePage from "./ChooseCreatePage";
import ManageTabsPage from "./ManageTabsPage";
import DesktopNexus from "./desktop/DesktopNexus";
import { useNexusController, type NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

function desktopWorkflow(input: {
  readonly controller: NexusController;
  readonly activeAddDefect: boolean;
  readonly onAddDefect: (error: unknown) => void;
  readonly onClearAddDefect: () => void;
}): ReactNode {
  const { controller, activeAddDefect, onAddDefect, onClearAddDefect } = input;
  const page = controller.page;
  let content: ReactNode;
  switch (page.kind) {
    case "Root":
    case "EntryActions":
      return undefined;
    case "CommandFailed":
      content = (
        <section className={styles.workflowPage}>
          <h2 tabIndex={-1} data-switchboard-heading>
            Command needs attention
          </h2>
          <FeedbackNotice
            content={page.content}
            announcement="Assertive"
            actions={[
              { label: "Retry", onClick: controller.retryCommandFailure },
              { label: "Back", onClick: controller.openRoot },
            ]}
          />
        </section>
      );
      break;
    case "UnsupportedLink":
      content = (
        <section className={styles.workflowPage}>
          <h2 tabIndex={-1} data-switchboard-heading>
            This link is no longer supported
          </h2>
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
    case "ChooseCreate":
      content = (
        <ChooseCreatePage
          initialDraft={page.initialDraft}
          actions={controller.createChoiceActions}
          onBack={controller.back}
          onSelect={(action, activation) =>
            controller.activateAction(action, activation)
          }
          onUnavailable={controller.announceUnavailable}
        />
      );
      break;
    case "ChooseBrowse":
      content = (
        <ChooseBrowsePage
          query={page.query}
          actions={controller.browseChoiceActions}
          onBack={controller.back}
          onSelect={(action, activation) =>
            controller.activateAction(action, activation)
          }
          onUnavailable={controller.announceUnavailable}
        />
      );
      break;
    case "CreatePage":
      content = (
        <section className={styles.workflowPage}>
          <h2 tabIndex={-1} data-switchboard-heading>
            New page
          </h2>
          {page.submit.kind === "Retryable" ? (
            <FeedbackNotice
              content={page.submit.content}
              announcement="Assertive"
              actions={[
                { label: "Retry", onClick: controller.retryPageCreation },
              ]}
            />
          ) : (
            <p>{`Creating “${page.titleDraft}”…`}</p>
          )}
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
    case "OperationBlocked":
      content = (
        <section className={styles.workflowPage}>
          <h2 tabIndex={-1} data-switchboard-heading>
            {page.title}
          </h2>
          <FeedbackNotice
            content={{
              tone: "Warning",
              title: page.title,
              message: page.message,
            }}
            announcement="Assertive"
            actions={
              page.retry === null
                ? [{ label: "Back", onClick: controller.back }]
                : [
                    {
                      label: "Retry",
                      onClick: controller.retryBlockedOperation,
                    },
                    { label: "Back", onClick: controller.back },
                  ]
            }
          >
            {page.manualValue ? <code>{page.manualValue}</code> : null}
          </FeedbackNotice>
        </section>
      );
      break;
    case "ManageTabs":
      content = (
        <ManageTabsPage
          origin={page.origin}
          panes={controller.managedPanes}
          recentlyClosed={controller.managedClosedPanes}
          onBack={controller.back}
          onOpen={controller.openManagedPane}
          onClose={controller.closeManagedPane}
          onRestore={controller.restoreManagedPane}
          onRetryRetained={controller.retryRetainedActivation}
          onCancelRetained={controller.cancelRetainedActivation}
          feedback={controller.managedTabsFeedback}
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
        const target = controller.initialFocus(event.currentTarget, false);
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
    readonly sessionId: string;
    readonly error: unknown;
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
  const pendingMobileNexusOpenerRef = useRef<HTMLButtonElement>(null);
  const currentMobileNexusButtonRef = useRef<HTMLButtonElement>(null);
  const openRoot = controller.openRoot;
  const setCurrentMobileNexusButton = useCallback(
    (node: HTMLButtonElement | null) => {
      currentMobileNexusButtonRef.current = node;
    },
    [],
  );
  const openMobileNexus = useCallback(
    (opener: HTMLButtonElement) => {
      pendingMobileNexusOpenerRef.current = opener;
      openRoot();
    },
    [openRoot],
  );
  const resolveMobileNexusReturnFocus = useCallback(() => {
    const opener = pendingMobileNexusOpenerRef.current;
    pendingMobileNexusOpenerRef.current = null;
    if (opener?.isConnected) return opener;
    const current = currentMobileNexusButtonRef.current;
    return current?.isConnected ? current : null;
  }, []);
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
      <SwitchboardTask
        controller={controller}
        active={controller.open && viewport.isMobile}
        returnFocusTo={resolveMobileNexusReturnFocus}
        activeAddDefect={addDefect?.sessionId === sessionId}
        onAddDefect={reportAddDefect}
        onClearAddDefect={clearAddDefect}
      />
      {viewport.isMobile && !waitingForViewport ? (
        <NexusButton
          paneCount={controller.paneCount}
          switchboardOpen={controller.open}
          onOpen={openMobileNexus}
          onButtonNodeChange={setCurrentMobileNexusButton}
        />
      ) : null}
      {!viewport.isMobile && !waitingForViewport ? (
        <DesktopNexus controller={desktopController} />
      ) : null}
    </>
  );
}
