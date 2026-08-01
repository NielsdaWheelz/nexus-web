"use client";

import { useRef, type MouseEvent, type ReactNode } from "react";
import AccountMenu from "@/components/appnav/AccountMenu";
import AddPanel, {
  type AddDismissalConfirmation,
} from "@/components/nexus/AddPanel";
import AddPanelBoundary from "@/components/nexus/AddPanelBoundary";
import ChooseBrowsePage from "@/components/nexus/ChooseBrowsePage";
import ChooseCreatePage from "@/components/nexus/ChooseCreatePage";
import ManageTabsPage from "@/components/nexus/ManageTabsPage";
import type { AddContentSessionController } from "@/components/nexus/useAddContentSession";
import type {
  NexusManagedClosedPane,
  NexusManagedPane,
} from "@/components/nexus/useNexusController";
import MobileFullScreenTask from "@/components/ui/MobileFullScreenTask";
import { getDestination } from "@/lib/navigation/destinations";
import type {
  MaterializedNexusTarget,
  NexusDispatchOutcome,
} from "@/lib/nexus/dispatch";
import type {
  NexusAction,
  NexusEntry,
  NexusEntryKey,
  NexusPage,
  NexusProjection,
  NexusTarget,
  NexusTargetActivation,
} from "@/lib/nexus/model";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import CreateLibraryPanel from "./CreateLibraryPanel";
import MobileNexusActivationAdapter, {
  type MobileNexusActivationAdapterHandle,
} from "./MobileNexusActivationAdapter";
import SwitchboardActions from "./SwitchboardActions";
import SwitchboardRecovery from "./SwitchboardRecovery";
import SwitchboardSearch, {
  type MobileNexusActionsRequest,
  type MobileNexusFailureSource,
} from "./SwitchboardSearch";
import styles from "./switchboard.module.css";

export interface MobileNexusTaskController {
  readonly query: string;
  readonly page: NexusPage;
  readonly projection: NexusProjection;
  readonly actionsRequest: MobileNexusActionsRequest | null;
  readonly failures: ReadonlySet<MobileNexusFailureSource>;
  readonly busy: boolean;
  readonly pending: boolean;
  readonly announcement: string;
  readonly dialogLabel: string;
  readonly focusKey: string;
  readonly addSession: AddContentSessionController;
  readonly dismissalConfirmation: AddDismissalConfirmation;
  readonly createChoiceActions: readonly NexusAction[];
  readonly browseChoiceActions: readonly NexusAction[];
  readonly managedPanes: readonly NexusManagedPane[];
  readonly managedClosedPanes: readonly NexusManagedClosedPane[];
  setQuery(query: string): void;
  setActiveEntry(key: NexusEntryKey): void;
  openEntryActions(entry: NexusEntry): void;
  announceUnavailable(reason: string): void;
  materialize(target: NexusTarget): MaterializedNexusTarget;
  dispatch(
    target: MaterializedNexusTarget,
    activation: NexusTargetActivation,
    entry?: NexusEntry,
  ): Promise<NexusDispatchOutcome>;
  reportActivationFailure(error: unknown): void;
  retry(source: MobileNexusFailureSource): void;
  back(): void;
  escape(): void;
  close(): void;
  dismissAccepted(): void;
  guardClose(): DismissDecision;
  initialFocus(container: HTMLElement, isMobile: boolean): HTMLElement | null;
  shouldSuppressReturnFocusOnClose(): boolean;
  openTarget(target: NexusTarget): void;
  openAddTarget(target: NexusTarget): void;
  keepWorking(): void;
  confirmDismissal(): void;
  setLibraryNameDraft(name: string): void;
  submitLibrary(): void;
  retryPageCreation(): void;
  manageTabs(): void;
  openManagedPane(paneId: string): void;
  closeManagedPane(paneId: string): void;
  restoreManagedPane(paneId: string): void;
  retryRetainedActivation(): void;
  cancelRetainedActivation(): void;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Switchboard page: ${JSON.stringify(value)}`);
}

function CreationStatus({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry(): void;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h2 tabIndex={-1} data-switchboard-heading>
          New page
        </h2>
      </header>
      <p>{failed ? "Couldn’t create page." : "Creating page…"}</p>
      {failed ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export default function SwitchboardTask({
  controller,
  active,
  activeAddDefect,
  onAddDefect,
  onClearAddDefect,
}: {
  controller: MobileNexusTaskController;
  active: boolean;
  activeAddDefect: boolean;
  onAddDefect(error: unknown): void;
  onClearAddDefect(): void;
}) {
  const activationAdapterRef =
    useRef<MobileNexusActivationAdapterHandle>(null);
  const settingsDestination = getDestination("settings");
  const accountSettings = {
    ...settingsDestination,
    icon:
      settingsDestination.icon ?? getPaneRouteIcon(settingsDestination.href),
    presentation: "default" as const,
  };
  const activate = (
    action: NexusAction,
    activation: NexusTargetActivation,
    returnFocus: HTMLElement,
    entry?: NexusEntry,
  ) => {
    activationAdapterRef.current?.activate(
      action,
      activation,
      returnFocus,
      entry,
    );
    if (entry) controller.setActiveEntry(entry.key);
  };
  const back = () => {
    controller.announceUnavailable("");
    controller.back();
  };
  const close = () => {
    controller.announceUnavailable("");
    controller.close();
  };
  const escape = () => {
    controller.announceUnavailable("");
    controller.escape();
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
      onNavigate={(event: MouseEvent<HTMLElement>): AppNavActivationResult => {
        event.preventDefault();
        controller.openTarget({
          kind: "InternalHref",
          href: settingsDestination.href,
          labelHint: settingsDestination.label,
        });
        return "handled-destination-focus";
      }}
    />
  );

  const renderPage = (): ReactNode => {
    const page = controller.page;
    switch (page.kind) {
      case "Root":
        return (
          <SwitchboardSearch
            active={active}
            focusKey={controller.focusKey}
            query={controller.query}
            projection={controller.projection}
            accountMenu={accountMenu}
            failures={controller.failures}
            busy={controller.busy}
            pending={controller.pending}
            announcement={controller.announcement}
            actionsRequest={controller.actionsRequest}
            onDone={close}
            onQuery={controller.setQuery}
            onActive={controller.setActiveEntry}
            onActivate={activate}
            onEntryActions={(entry) => {
              controller.announceUnavailable("");
              controller.openEntryActions(entry);
            }}
            onEscapeRoot={escape}
            onUnavailable={controller.announceUnavailable}
            onRetry={controller.retry}
          />
        );
      case "EntryActions":
        return (
          <SwitchboardActions
            entry={page.entry}
            onBack={back}
            onSelect={activate}
            onUnavailable={controller.announceUnavailable}
            unavailableAnnouncement={controller.announcement}
          />
        );
      case "ChooseCreate":
        return (
          <ChooseCreatePage
            initialDraft={page.initialDraft}
            actions={controller.createChoiceActions}
            onBack={back}
            onSelect={activate}
            onUnavailable={controller.announceUnavailable}
          />
        );
      case "ChooseBrowse":
        return (
          <ChooseBrowsePage
            query={page.query}
            actions={controller.browseChoiceActions}
            onBack={back}
            onSelect={activate}
            onUnavailable={controller.announceUnavailable}
          />
        );
      case "ManageTabs":
        return (
          <ManageTabsPage
            origin={page.origin}
            panes={controller.managedPanes}
            recentlyClosed={controller.managedClosedPanes}
            onBack={back}
            onOpen={controller.openManagedPane}
            onClose={controller.closeManagedPane}
            onRestore={controller.restoreManagedPane}
            onRetryRetained={controller.retryRetainedActivation}
            onCancelRetained={controller.cancelRetainedActivation}
          />
        );
      case "UnsupportedLink":
        return (
          <div className={styles.page}>
            <header className={styles.header}>
              <h2 tabIndex={-1} data-switchboard-heading>
                This link is no longer supported
              </h2>
            </header>
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
          </div>
        );
      case "CreatePage":
        return (
          <CreationStatus
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
            onBack={back}
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
              onClose={close}
              onBack={back}
              onKeepWorking={controller.keepWorking}
              onConfirmDismissal={controller.confirmDismissal}
              onDefect={onAddDefect}
            />
          </AddPanelBoundary>
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
      default:
        return assertNever(page);
    }
  };

  return (
    <>
      <MobileFullScreenTask
        active={active}
        onDismiss={() => {
          controller.announceUnavailable("");
          controller.dismissAccepted();
        }}
        onDismissRequest={() => {
          controller.announceUnavailable("");
          return controller.guardClose();
        }}
        ariaLabel={activeAddDefect ? "Add needs attention" : controller.dialogLabel}
        initialFocus={(container) => controller.initialFocus(container, true)}
        returnFocusTo={() =>
          document.querySelector<HTMLElement>("[data-nexus-return-focus]")
        }
        skipReturnFocus={controller.shouldSuppressReturnFocusOnClose}
        focusKey={controller.focusKey}
      >
        {renderPage()}
        {controller.page.kind !== "Root" &&
        controller.page.kind !== "EntryActions" ? (
          <div
            className={styles.liveRegion}
            role="status"
            aria-label="Nexus status"
            aria-live="polite"
          >
            {controller.announcement}
          </div>
        ) : null}
      </MobileFullScreenTask>
      <MobileNexusActivationAdapter
        ref={activationAdapterRef}
        materialize={controller.materialize}
        dispatch={controller.dispatch}
        onError={controller.reportActivationFailure}
      />
    </>
  );
}
