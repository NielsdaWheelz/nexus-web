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
import TodayCapturePanel from "./TodayCapturePanel";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import SwitchboardPodcastPanel from "@/components/switchboard/SwitchboardPodcastPanel";
import SwitchboardRecovery from "@/components/switchboard/SwitchboardRecovery";
import LauncherFooter from "./LauncherFooter";
import LauncherInput from "./LauncherInput";
import LauncherLaneChips from "./LauncherLaneChips";
import LauncherList from "./LauncherList";
import styles from "./launcher.module.css";

function retainedTargetLabel(controller: LauncherController): string {
  if (controller.page.kind !== "ManageTabs") {
    throw new Error("Retained target label requires ManageTabs");
  }
  return (
    controller.page.retained.target.labelHint ??
    controller.page.retained.target.href
  );
}

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
          {controller.page.kind === "Add" ? (
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
          ) : controller.page.kind === "TodayCapture" ? (
            <TodayCapturePanel
              session={controller.todaySession}
              onOpen={controller.openTarget}
              onBack={controller.back}
            />
          ) : controller.page.kind === "CreateLibrary" ? (
            <CreateLibraryPanel
              name={controller.page.nameDraft}
              submit={controller.page.submit}
              onName={controller.setLibraryNameDraft}
              onBack={controller.back}
              onSubmit={controller.submitLibrary}
            />
          ) : controller.page.kind === "PodcastDiscovery" ? (
            <SwitchboardPodcastPanel
              query={controller.page.query}
              results={controller.podcastResults}
              busy={controller.podcastBusy}
              subscribingId={controller.podcastSubscribingId}
              failed={controller.podcastFailed}
              onBack={controller.back}
              onQuery={controller.setPodcastQuery}
              onSelect={controller.selectPodcast}
              onRetry={controller.retryPodcastSearch}
            />
          ) : controller.page.kind === "ActivationBlocked" ? (
            <SwitchboardRecovery
              retained={controller.page.retained}
              onManageTabs={controller.manageTabs}
              onOpen={controller.retryRetainedActivation}
              onCancel={controller.cancelRetainedActivation}
            />
          ) : controller.page.kind === "CreatePage" ? (
            <div>
              <h2 data-switchboard-heading>New page</h2>
              <p>
                {controller.page.submit.kind === "Retryable"
                  ? controller.page.submit.message
                  : "Creating page…"}
              </p>
              {controller.page.submit.kind === "Retryable" ? (
                <button type="button" onClick={controller.retryPageCreation}>
                  Retry
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {controller.page.kind === "ManageTabs" ? (
                <section className={styles.retainedBanner}>
                  <h2 tabIndex={-1} data-switchboard-open-heading>
                    Open
                  </h2>
                  <p>
                    Close a tab, then open {retainedTargetLabel(controller)}.
                  </p>
                  <div>
                    <button
                      type="button"
                      onClick={controller.retryRetainedActivation}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={controller.cancelRetainedActivation}
                    >
                      Cancel
                    </button>
                  </div>
                </section>
              ) : null}
              <LauncherInput controller={controller} />
              {controller.page.kind === "Root" ||
              controller.page.kind === "Find" ||
              controller.page.kind === "ManageTabs" ? (
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
