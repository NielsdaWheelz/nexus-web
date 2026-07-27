"use client";

import type { MouseEvent, ReactNode } from "react";
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

function assertNever(value: never): never {
  throw new Error(`Unhandled Switchboard page: ${JSON.stringify(value)}`);
}

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

  // One exhaustive switch over the page union: a new LauncherPage variant is a
  // compile error here instead of silently falling through to the Root render.
  const renderPage = (): ReactNode => {
    const page = controller.page;
    switch (page.kind) {
      case "Root":
        return root();
      case "Find":
        return (
          <SwitchboardFind
            query={page.query}
            scope={page.scope}
            rows={controller.switchboardFindRows}
            activeId={controller.switchboardFindActiveId}
            busy={controller.switchboardFindBusy}
            pending={controller.switchboardFindPending}
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
        );
      case "Actions":
        return (
          <SwitchboardActions
            label={page.item.title}
            actions={page.actions}
            onBack={controller.back}
            onSelect={controller.runAction}
          />
        );
      case "TodayCapture":
        return (
          <TodayCapturePanel
            session={controller.todaySession}
            onOpen={controller.openTarget}
            onBack={controller.back}
          />
        );
      case "CreatePage":
        return (
          <CreationStatus
            kind="page"
            failed={page.submit.kind === "Retryable"}
            onRetry={controller.retryPageCreation}
          />
        );
      case "CreateLibrary":
        return (
          <CreateLibraryPanel
            name={page.nameDraft}
            submit={page.submit}
            onName={controller.setLibraryNameDraft}
            onBack={controller.back}
            onSubmit={controller.submitLibrary}
          />
        );
      case "Add":
        return (
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
      case "PodcastDiscovery":
        return (
          <SwitchboardPodcastPanel
            query={page.query}
            results={controller.podcastResults}
            busy={controller.podcastBusy}
            subscribingId={controller.podcastSubscribingId}
            failed={controller.podcastFailed}
            onBack={controller.back}
            onQuery={controller.setPodcastQuery}
            onSelect={controller.selectPodcast}
            onRetry={controller.retryPodcastSearch}
          />
        );
      case "ActivationBlocked":
        return (
          <SwitchboardRecovery
            retained={page.retained}
            onManageTabs={controller.manageTabs}
            onOpen={controller.retryRetainedActivation}
            onCancel={controller.cancelRetainedActivation}
          />
        );
      case "ManageTabs":
        return root(true);
      default:
        return assertNever(page);
    }
  };

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
      {renderPage()}
    </MobileSheet>
  );
}
