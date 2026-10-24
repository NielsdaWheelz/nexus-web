"use client";

// Every Nexus page but Root, one tree for both surfaces.
import { ArrowLeft, RotateCcw } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import Button from "@/components/ui/Button";
import { assertNever } from "@/lib/assertNever";
import { tabState } from "@/lib/nexus/rows";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import { paneControls } from "@/lib/workspace/paneControls";
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
  const stateDescriptionId = useId();
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
        onBack={controller.back}
      />
      <NexusTitleFailure failed={controller.titlesFailed} retry={controller.retryTitles} />
      <section className={styles.tabs} aria-labelledby="nexus-open-tabs">
        <h3 id="nexus-open-tabs">{mobile ? "open" : "Open"}</h3>
        <ul>
          {controller.panes.map((pane) => (
            <li key={pane.id}>
              <button className={styles.tabOpen} type="button" data-nexus-control={`Pane:${pane.id}`} aria-label={mobile && pane.visibility === "minimized" ? `restore ${pane.presentation.title}` : pane.presentation.title} aria-current={pane.current ? "page" : undefined}
                aria-describedby={mobile ? undefined : `${stateDescriptionId}-${pane.id}`}
                ref={(element) => { if (element) triggers.current.set(pane.id, element); else triggers.current.delete(pane.id); }}
                onClick={(event) => {
                  const detail = prepareActionSelect(event, null);
                  if (detail) controller.openPane(pane.id, detail.openIntent);
                }}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && (event.repeat || event.nativeEvent.isComposing)) {
                    event.preventDefault();
                    return;
                  }
                  const detail = prepareActionSelect(event, null);
                  if (detail) controller.openPane(pane.id, detail.openIntent);
                }}>
                <span className={styles.tabIdentity}><span>{pane.presentation.title}</span>{pane.presentation.detail ? <small>{pane.presentation.detail}</small> : null}
                  {mobile ? tabState(pane) === "Open" ? null : <small>{tabState(pane).toLowerCase()}</small> : <small id={`${stateDescriptionId}-${pane.id}`}>{controller.desktopMaximized && pane.current ? "maximized" : tabState(pane).toLowerCase()} tab</small>}
                </span>
              </button>
              <div className={styles.tabActions}>
                {paneControls({ state: controller.workspaceState, paneId: pane.id, title: pane.presentation.title, desktopMaximized: controller.desktopMaximized, isMobile: mobile }).map((control) => {
                  const Icon = control.icon;
                  return <Button
                    key={control.slot}
                    iconOnly
                    icon={<Icon size={18} aria-hidden="true" />}
                    aria-label={control.label}
                    aria-disabled={control.disabledReason !== null || undefined}
                    tooltip={{ text: control.disabledReason ?? control.tooltip }}
                    onPointerDown={(event) => {
                      if (isTopmostInteractionOwner("Nexus")) event.currentTarget.focus({ preventScroll: true });
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      if (!event.repeat && !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey) event.currentTarget.click();
                    }}
                    onClick={(event) => {
                      if (!isTopmostInteractionOwner("Nexus")) return;
                      event.currentTarget.focus({ preventScroll: true });
                      switch (control.command) {
                        case "minimize": {
                          const selection = controller.minimizePane(pane.id);
                          if (mobile && selection !== null) setFocusPaneId(pane.id);
                          return;
                        }
                        case "maximize": controller.maximizePane(pane.id); return;
                        case "restore_canvas": controller.restoreCanvas(pane.id); return;
                        case "close": close(pane.id); return;
                        default: assertNever(control.command);
                      }
                    }}
                  />;
                })}
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
                <button className={styles.tabOpen} type="button" aria-label={`${mobile ? "restore" : "Restore"} ${pane.presentation.title}`} onClick={() => controller.restoreClosedPane(pane.id)}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && (event.repeat || event.nativeEvent.isComposing)) event.preventDefault();
                  }}>
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
