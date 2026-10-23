"use client";

// Every Nexus page but Root, one tree for both surfaces.
import { ArrowLeft, RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { tabState } from "@/lib/nexus/rows";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import { paneActions } from "@/lib/workspace/paneActions";
import AddPanel from "./AddPanel";
import AddPanelBoundary from "./AddPanelBoundary";
import { NexusTitleFailure } from "./NexusRow";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

function Header({ title, subtitle, onBack }: { title: string; subtitle?: ReactNode; onBack?: () => void }) {
  return (
    <header className={styles.header}>
      {onBack ? (
        <Button iconOnly icon={<ArrowLeft />} className={styles.iconButton} aria-label="back" onClick={onBack} />
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
    if (selection === null) return;
    setFocusPaneId(neighbor?.id ?? selection.paneId);
  };
  return (
    <section className={styles.page}>
      <Header
        title={mobile ? "all tabs" : "Manage tabs"}
        subtitle={mobile ? undefined : "Open, close, restore, or reorder workspace tabs."}
        onBack={controller.back}
      />
      <NexusTitleFailure failed={controller.titlesFailed} retry={controller.retryTitles} />
      <section className={styles.tabs} aria-labelledby="nexus-open-tabs">
        <h3 id="nexus-open-tabs">{mobile ? "open" : "Open"}</h3>
        <ul>
          {controller.panes.map((pane) => (
            <li key={pane.id}>
              <button className={styles.tabOpen} type="button" data-nexus-control={`Pane:${pane.id}`} aria-label={pane.presentation.title} aria-current={pane.current ? "page" : undefined}
                ref={mobile ? (element) => { if (element) triggers.current.set(pane.id, element); else triggers.current.delete(pane.id); } : undefined}
                onClick={(event) => {
                  const detail = prepareActionSelect(event, null);
                  if (detail) controller.openPane(pane.id, detail.openIntent);
                }}
                onKeyDown={(event) => {
                  const detail = prepareActionSelect(event, null);
                  if (detail) controller.openPane(pane.id, detail.openIntent);
                }}>
                <span className={styles.tabIdentity}><span>{pane.presentation.title}</span>{pane.presentation.detail ? <small>{pane.presentation.detail}</small> : null}
                  {mobile ? tabState(pane) === "Open" ? null : <small>{tabState(pane).toLowerCase()}</small> : <small>{tabState(pane)} tab</small>}
                </span>
              </button>
              <div className={styles.tabActions}>
                <ActionMenu
                  label={`more actions for ${pane.presentation.title}`}
                  triggerRef={mobile ? undefined : (element) => {
                    if (element) triggers.current.set(pane.id, element);
                    else triggers.current.delete(pane.id);
                  }}
                  source={{ kind: "Immediate", subjectKey: `nexus-tab:${pane.id}`, title: pane.presentation.title, content: { sections: [{ id: "Pane", label: null, options: paneActions({
                    state: controller.workspaceState,
                    paneId: pane.id,
                    onMinimize: controller.minimizePane,
                    onRestore: controller.restorePane,
                    onMove: controller.movePane,
                    onClose: close,
                  }) }] } }}
                />
                <Button
                  iconOnly
                  tabIndex={mobile ? undefined : -1}
                  aria-label={`${mobile ? "close" : "Close"} ${pane.presentation.title}`}
                  onClick={() => close(pane.id)}
                  icon={<X size={18} aria-hidden="true" />} />
              </div>
            </li>
          ))}
        </ul>
      </section>
      {controller.closedPanes.length > 0 ? (
        <section className={styles.tabs} aria-labelledby="nexus-closed-tabs">
          <h3 id="nexus-closed-tabs">{mobile ? "recently closed" : "Recently closed"}</h3>
          <ul>
            {controller.closedPanes.map((pane) => (
              <li key={pane.id}>
                <button className={styles.tabOpen} type="button" aria-label={`${mobile ? "restore" : "Restore"} ${pane.presentation.title}`} onClick={() => controller.restoreClosedPane(pane.id)}>
                  <RotateCcw size={18} aria-hidden="true" />
                  <span>{pane.presentation.title}</span>
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
            title={mobile ? page.kind === "ChooseCreate" ? page.draft ? "create from text" : "new" : "browse" : page.kind === "ChooseCreate" ? `Create “${page.draft}”` : `Browse${page.query ? ` for “${page.query}”` : ""}`}
            subtitle={mobile ? (page.kind === "ChooseCreate" ? page.draft : page.query) ? <span className={styles.draftPreview}>{page.kind === "ChooseCreate" ? page.draft : page.query}</span> : undefined : page.kind === "ChooseCreate" ? "Choose where this draft belongs." : "Choose one source kind."}
            onBack={controller.back}
          />
          <div className={styles.choices}>
            {controller.choices.map((row) => {
              const activate = (event: import("@/lib/ui/targetActivation").TargetActivationEvent) => {
                const detail = prepareActionSelect(event, null);
                if (detail) controller.activate(row.action, { disposition: { kind: detail.openIntent === "new_pane" ? "Fork" : "Follow" } });
              };
              return (
              <button
                key={row.key}
                type="button"
                data-nexus-control={row.key}
                aria-disabled={row.action.kind === "Unavailable" || undefined}
                onClick={activate}
                onKeyDown={activate}
              >
                <row.icon size={18} aria-hidden="true" />
                <span>
                  {row.label}
                  {row.action.kind === "Unavailable" ? <small>{row.action.reason}</small> : null}
                </span>
              </button>
            ); })}
          </div>
        </section>
      );
    case "CaptureToday":
      return (
        <section className={styles.page}>
          <Header title={mobile ? "add to today" : "Add to Today"} onBack={controller.back} />
          {page.submit.kind !== "Ready" && page.submit.content ? (
            <FeedbackNotice
              content={page.submit.content}
              announcement="Assertive"
              actions={page.submit.kind === "Acknowledged" ? undefined : [{ label: "retry same request", onClick: controller.retryCapture, busy: page.submit.kind === "Running" }]}
            />
          ) : (
            <FeedbackStatus content={{ tone: "Neutral", title: `adding “${page.text}” to today…` }} announcement="Polite" />
          )}
        </section>
      );
    case "CreateLibrary":
      return (
        <CreateLibraryPanel
          mobile={mobile}
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
            openingSources={controller.openingSources}
            onOpen={controller.openAddTarget}
            onClose={controller.close}
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
