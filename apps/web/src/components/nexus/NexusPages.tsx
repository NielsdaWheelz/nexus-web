"use client";

// Every Nexus page but Root, one tree for both surfaces.
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import Button from "@/components/ui/Button";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import AddPanel from "./AddPanel";
import AddPanelBoundary from "./AddPanelBoundary";
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

function Page({ controller, mobile }: { controller: NexusController; mobile: boolean }) {
  const { page } = controller;
  switch (page.kind) {
    case "Root":
      return null;
    case "UseText":
    case "ChooseCreate":
    case "ChooseBrowse":
      return (
        <section className={styles.page}>
          <Header
            title={page.kind === "UseText" ? "use this text" : page.kind === "ChooseCreate" ? "create" : "browse"}
            onBack={controller.back}
          />
          {(page.kind === "UseText" ? page.text : page.kind === "ChooseCreate" ? page.draft : page.query) ? <p className={styles.textPreview}>{page.kind === "UseText" ? page.text : page.kind === "ChooseCreate" ? page.draft : page.query}</p> : null}
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
          <Header title="add to today" onBack={controller.back} />
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
