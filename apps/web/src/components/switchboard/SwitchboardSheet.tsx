"use client";

import type { MouseEvent } from "react";
import MobileSheet from "@/components/ui/MobileSheet";
import AccountMenu from "@/components/appnav/AccountMenu";
import AddPanel from "@/components/launcher/AddPanel";
import AddPanelBoundary from "@/components/launcher/AddPanelBoundary";
import TodayCapturePanel from "@/components/launcher/TodayCapturePanel";
import { getDestination } from "@/lib/navigation/destinations";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { LauncherController } from "@/components/launcher/useLauncherController";
import CreateLibraryPanel from "./CreateLibraryPanel";
import SwitchboardActions from "./SwitchboardActions";
import SwitchboardFind from "./SwitchboardFind";
import SwitchboardPodcastPanel from "./SwitchboardPodcastPanel";
import SwitchboardRecovery from "./SwitchboardRecovery";
import SwitchboardRoot from "./SwitchboardRoot";
import { useSwitchboardController } from "./useSwitchboardController";
import styles from "./switchboard.module.css";

function CreationStatus({
  kind,
  failed,
  onRetry,
}: {
  kind: "page";
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h2 tabIndex={-1} data-switchboard-heading>
          New {kind}
        </h2>
      </header>
      <p>{failed ? `Couldn’t create ${kind}.` : `Creating ${kind}…`}</p>
      {failed ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export default function SwitchboardSheet({
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
  const switchboard = useSwitchboardController(controller);
  const settingsDestination = getDestination("settings");
  const accountSettings = {
    ...settingsDestination,
    icon:
      settingsDestination.icon ??
      getPaneRouteIcon(settingsDestination.href),
    presentation: "default" as const,
  };
  const accountMenu = (
    <AccountMenu
      settings={accountSettings}
      active={false}
      placement="below"
      align="end"
      renderTrigger={(trigger) => (
        <button
          {...trigger}
          type="button"
          className={styles.textButton}
          aria-label="Account"
        >
          Account
        </button>
      )}
      onNavigate={(
        event: MouseEvent<HTMLElement>,
      ): AppNavActivationResult => {
        event.preventDefault();
        controller.openSwitchboardPlace(settingsDestination);
        return "handled-destination-focus";
      }}
    />
  );

  const root = (manageTabs = false) => (
    <SwitchboardRoot
      places={switchboard.places}
      quickActions={controller.switchboardQuickActions}
      panes={switchboard.panes}
      recentlyClosed={switchboard.recentlyClosed}
      accountMenu={accountMenu}
      manageTabs={manageTabs}
      retainedTarget={
        manageTabs &&
        (controller.page.kind === "ManageTabs" ||
          controller.page.kind === "ActivationBlocked")
          ? controller.page.retained.target.labelHint ??
            controller.page.retained.target.href
          : undefined
      }
      onDone={controller.close}
      onFind={controller.enterFind}
      onPlace={controller.openSwitchboardPlace}
      onQuickAction={controller.runSwitchboardQuickAction}
      onOpenPane={(paneId) => {
        const pane = controller.switchboardPanes.find(
          (candidate) => candidate.id === paneId,
        );
        if (!pane) {
          throw new Error(`Unknown Switchboard pane: ${paneId}`);
        }
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
    />
  );

  return (
    <MobileSheet
      active={active}
      onDismiss={controller.dismissAccepted}
      onDismissRequest={controller.guardClose}
      ariaLabel={activeAddDefect ? "Add needs attention" : "Nexus"}
      layer="palette"
      panelClassName={styles.sheet}
      initialFocus={(container) => controller.initialFocus(container, true)}
      skipReturnFocus={controller.shouldSuppressReturnFocusOnClose}
      focusKey={controller.focusKey}
      panelId="nexus-switchboard"
    >
      {controller.page.kind === "Root"
        ? root()
        : controller.page.kind === "Find"
          ? (
              <SwitchboardFind
                query={controller.page.query}
                scope={controller.page.scope}
                rows={controller.switchboardFindRows}
                activeId={controller.switchboardFindActiveId}
                busy={controller.switchboardFindBusy}
                openablesFailed={controller.switchboardOpenablesFailed}
                deepFailed={controller.switchboardDeepFailed}
                onBack={controller.back}
                onQuery={controller.setQuery}
                onScope={controller.setFindScope}
                onActive={controller.setSwitchboardFindActiveId}
                onSelect={(row) => {
                  if (row.item) {
                    controller.openSwitchboardItem(row.item, false);
                  }
                }}
                onFork={(row) => {
                  if (row.item) {
                    controller.openSwitchboardItem(row.item, true);
                  }
                }}
                actionsFor={controller.switchboardItemActions}
                onAction={controller.runSwitchboardAction}
                onRetryOpenables={controller.retrySwitchboardOpenables}
                onRetryDeep={controller.retrySwitchboardDeep}
              />
            )
          : controller.page.kind === "Actions"
            ? (
                <SwitchboardActions
                  label={controller.page.item.title}
                  actions={controller.page.actions}
                  onBack={controller.back}
                  onSelect={controller.runAction}
                />
              )
            : controller.page.kind === "TodayCapture"
              ? (
                  <TodayCapturePanel
                    session={controller.todaySession}
                    onOpen={controller.openTarget}
                    onBack={controller.back}
                  />
                )
              : controller.page.kind === "CreatePage"
                ? (
                    <CreationStatus
                      kind="page"
                      failed={controller.page.submit.kind === "Retryable"}
                      onRetry={controller.retryPageCreation}
                    />
                  )
                : controller.page.kind === "CreateLibrary"
                  ? (
                      <CreateLibraryPanel
                        name={controller.page.nameDraft}
                        submit={controller.page.submit}
                        onName={controller.setLibraryNameDraft}
                        onBack={controller.back}
                        onSubmit={controller.submitLibrary}
                      />
                    )
                  : controller.page.kind === "Add"
                    ? (
                        <AddPanelBoundary
                          activeDefect={activeAddDefect}
                          resetKey={controller.page.sessionId}
                          session={controller.addSession}
                          controller={controller}
                          onClearDefect={onClearAddDefect}
                          onDefect={onAddDefect}
                        >
                          <AddPanel
                            session={controller.addSession}
                            dismissalConfirmation={
                              controller.dismissalConfirmation
                            }
                            onOpen={controller.openAddTarget}
                            onClose={controller.close}
                            onBack={controller.back}
                            onKeepWorking={controller.keepWorking}
                            onConfirmDismissal={
                              controller.confirmDismissal
                            }
                            onDefect={onAddDefect}
                          />
                        </AddPanelBoundary>
                      )
                    : controller.page.kind === "PodcastDiscovery"
                      ? (
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
                        )
                      : controller.page.kind === "ActivationBlocked"
                        ? (
                            <SwitchboardRecovery
                              retained={controller.page.retained}
                              onManageTabs={controller.manageTabs}
                              onOpen={controller.retryRetainedActivation}
                              onCancel={controller.cancelRetainedActivation}
                            />
                          )
                        : root(true)}
    </MobileSheet>
  );
}
