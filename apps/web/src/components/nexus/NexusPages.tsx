"use client";

// Every Nexus page but Root, one tree for both surfaces.
import { ArrowLeft, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import type { Retained } from "@/lib/nexus/model";
import { tabState } from "@/lib/nexus/rows";
import AddPanel from "./AddPanel";
import AddPanelBoundary from "./AddPanelBoundary";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

const COMPLETION: Record<Retained["completion"], string> = {
  Destination: "Your destination is ready to open.",
  Page: "Your page was created.",
  Library: "Your library was created.",
  Import: "Your import completed.",
};

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

function retainedLabel({ target }: Retained): string {
  if (target.kind === "InternalHref") return target.labelHint ?? target.href;
  return target.entry.kind === "AppendNote" ? "Quick Note" : "Today";
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
                onClick={(event) =>
                  controller.activate(
                    row.action,
                    { disposition: { kind: "Follow" } },
                    event.currentTarget,
                  )
                }
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
            session={controller.addSession}
            dismissalConfirmation={controller.dismissalConfirmation}
            onOpen={controller.openAddTarget}
            onClose={controller.close}
            onBack={controller.back}
            onKeepWorking={controller.keepWorking}
            onConfirmDismissal={controller.confirmDismissal}
            onDefect={controller.reportAddDefect}
          />
        </AddPanelBoundary>
      );
    case "Blocked":
      return (
        <section className={styles.page}>
          <Header title="Tab limit reached" />
          <p>{COMPLETION[page.retained.completion]} Close a tab, then open it.</p>
          <div className={styles.actions}>
            <button type="button" onClick={controller.manageTabs}>
              Manage tabs
            </button>
            <button type="button" onClick={controller.retryRetained}>
              Open
            </button>
            <button type="button" onClick={controller.cancelRetained}>
              Cancel
            </button>
          </div>
        </section>
      );
    case "ManageTabs": {
      const swipe = mobile && controller.panes.filter((pane) => pane.visibility === "visible").length >= 2;
      return (
        <section className={styles.page}>
          <Header
            title="Manage tabs"
            subtitle={`Open, close, or restore a workspace tab.${swipe ? " Swipe the Nexus button left or right to switch visible tabs." : ""}`}
            onBack={controller.back}
          />
          {page.retained ? (
            <div className={styles.recovery}>
              <p>Make room, then open {retainedLabel(page.retained)}.</p>
              <div className={styles.actions}>
                <button type="button" onClick={controller.retryRetained}>
                  Retry open
                </button>
                <button type="button" onClick={controller.cancelRetained}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {page.restoreBlocked ? (
            <FeedbackNotice
              content={{ tone: "Warning", title: "Tab limit reached", message: "Close a tab, then restore this one." }}
              announcement="Assertive"
              actions={[{ label: "Retry", onClick: () => controller.restorePane(page.restoreBlocked!) }]}
            />
          ) : null}
          <section className={styles.tabs} aria-labelledby="nexus-open-tabs">
            <h3 id="nexus-open-tabs">Open</h3>
            <ul>
              {controller.panes.map((pane) => (
                <li key={pane.id}>
                  <button type="button" onClick={() => controller.openPane(pane.id)}>
                    <span>{pane.label}</span>
                    <small>{tabState(pane)} tab</small>
                  </button>
                  <button type="button" aria-label={`Close ${pane.label}`} onClick={() => controller.closePane(pane.id)}>
                    <X size={18} aria-hidden="true" />
                  </button>
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
                    <button type="button" onClick={() => controller.restorePane(pane.id)}>
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
