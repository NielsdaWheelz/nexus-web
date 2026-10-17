"use client";

// Every Nexus page but Root, one tree for both surfaces.
import { ArrowLeft, RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { tabState } from "@/lib/nexus/rows";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { paneActions } from "@/lib/workspace/paneActions";
import AddPanel from "./AddPanel";
import AddPanelBoundary from "./AddPanelBoundary";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

function Header({ title, subtitle, onBack }: { title: string; subtitle?: ReactNode; onBack?: () => void }) {
  return (
    <header className={styles.header}>
      {onBack ? (
        <button type="button" className={styles.iconButton} aria-label="Back" onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
      ) : null}
      <div className={styles.heading}>
        <h2 tabIndex={-1} data-switchboard-heading>
          {title}
        </h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
    </header>
  );
}

function ManageTabs({ controller, mobile }: { controller: NexusController; mobile: boolean }) {
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const [focusPaneId, setFocusPaneId] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (focusPaneId === null) return;
    if (isTopmostInteractionOwner("Nexus")) {
      triggers.current.get(focusPaneId)?.focus({ preventScroll: true });
    }
    setFocusPaneId(null);
  }, [focusPaneId]);
  const close = (paneId: string) => {
    const index = controller.panes.findIndex((pane) => pane.id === paneId);
    const neighbor = controller.panes[index + 1] ?? controller.panes[index - 1];
    const selection = controller.closePane(paneId);
    setFocusPaneId(neighbor?.id ?? selection.paneId);
  };
  const swipe = mobile && controller.panes.filter((pane) => pane.visibility === "visible").length >= 2;
  return (
    <section className={styles.page}>
      <Header
        title="Manage tabs"
        subtitle={`Open, close, restore, or reorder workspace tabs.${swipe ? " Swipe the Nexus button left or right to switch visible tabs." : ""}`}
        onBack={controller.back}
      />
      <section className={styles.tabs} aria-labelledby="nexus-open-tabs">
        <h3 id="nexus-open-tabs">Open</h3>
        <ul>
          {controller.panes.map((pane) => (
            <li key={pane.id}>
              <button className={styles.tabOpen} type="button" onClick={() => controller.openPane(pane.id)}>
                <span>{pane.label}</span>
                <small>{tabState(pane)} tab</small>
              </button>
              <div className={styles.tabActions}>
                <ActionMenu
                  label={`Tab actions for ${pane.label}`}
                  triggerRef={(element) => {
                    if (element) triggers.current.set(pane.id, element);
                    else triggers.current.delete(pane.id);
                  }}
                  options={paneActions({
                    state: controller.workspaceState,
                    paneId: pane.id,
                    onMinimize: controller.minimizePane,
                    onRestore: controller.restorePane,
                    onMove: controller.movePane,
                    onClose: close,
                  })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  tabIndex={-1}
                  aria-label={`Close ${pane.label}`}
                  onClick={() => close(pane.id)}
                >
                  <X size={18} aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {controller.closedPanes.length > 0 ? (
        <section className={styles.tabs} aria-labelledby="nexus-closed-tabs">
          <h3 id="nexus-closed-tabs">Recently closed</h3>
          <ul>
            {controller.closedPanes.map((pane) => (
              <li key={pane.id}>
                <button className={styles.tabOpen} type="button" onClick={() => controller.restoreClosedPane(pane.id)}>
                  <RotateCcw size={18} aria-hidden="true" />
                  <span>{pane.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function Page({ controller, mobile }: { controller: NexusController; mobile: boolean }) {
  const { page } = controller;
  switch (page.kind) {
    case "Root":
      return null;
    case "ChooseCreate":
    case "ChooseBrowse":
      return (
        <section className={styles.page}>
          <Header
            title={page.kind === "ChooseCreate" ? `Create “${page.draft}”` : `Browse${page.query ? ` for “${page.query}”` : ""}`}
            subtitle={page.kind === "ChooseCreate" ? "Choose where this draft belongs." : "Choose one source kind."}
            onBack={controller.back}
          />
          <div className={styles.choices}>
            {controller.choices.map((row) => (
              <button
                key={row.key}
                type="button"
                aria-disabled={row.action.kind === "Unavailable" || undefined}
                onClick={() => controller.activate(row.action, { disposition: { kind: "Follow" } })}
              >
                <row.icon size={18} aria-hidden="true" />
                <span>
                  {row.label}
                  {row.action.kind === "Unavailable" ? <small>{row.action.reason}</small> : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      );
    case "CreatePage":
      return (
        <section className={styles.page}>
          <Header title="New page" />
          {page.submit.kind === "Retryable" ? (
            <FeedbackNotice
              content={page.submit.content}
              announcement="Assertive"
              actions={[{ label: "Retry", onClick: controller.retryPage }]}
            />
          ) : (
            <p>{`Creating “${page.title}”…`}</p>
          )}
        </section>
      );
    case "CaptureToday":
      return (
        <section className={styles.page}>
          <Header title="Add to Today" onBack={controller.back} />
          {page.submit.kind === "Retryable" ? (
            <FeedbackNotice
              content={page.submit.content}
              announcement="Assertive"
              actions={[{ label: "Retry", onClick: controller.retryCapture }]}
            />
          ) : (
            <p role="status">{`Adding “${page.text}” to Today…`}</p>
          )}
        </section>
      );
    case "CreateLibrary":
      return (
        <CreateLibraryPanel
          name={page.name}
          submit={page.submit}
          onName={controller.setLibraryName}
          onBack={controller.back}
          onSubmit={controller.submitLibrary}
        />
      );
    case "Add":
      return (
        <AddPanelBoundary
          activeDefect={controller.addDefect}
          resetKey={page.sessionId}
          session={controller.addSession}
          controller={controller}
          onClearDefect={controller.clearAddDefect}
          onDefect={controller.reportAddDefect}
        >
          <AddPanel
            key={page.sessionId}
            session={controller.addSession}
            mobile={mobile}
            dismissalConfirmation={controller.dismissalConfirmation}
            onOpen={controller.openAddTarget}
            onClose={controller.close}
            onKeepWorking={controller.keepWorking}
            onConfirmDismissal={controller.confirmDismissal}
            onDefect={controller.reportAddDefect}
          />
        </AddPanelBoundary>
      );
    case "ManageTabs":
      return <ManageTabs controller={controller} mobile={mobile} />;
  }
}

export default function NexusPages({ controller, mobile }: { controller: NexusController; mobile: boolean }) {
  return (
    <>
      <Page controller={controller} mobile={mobile} />
      <div className="sr-only" role="status" aria-label="Nexus status" aria-live="polite">
        {controller.announcement}
      </div>
    </>
  );
}
