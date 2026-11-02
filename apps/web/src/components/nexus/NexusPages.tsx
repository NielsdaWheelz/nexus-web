"use client";

// Every Nexus page but Root, one tree for both surfaces.
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import CreateLibraryPanel from "@/components/switchboard/CreateLibraryPanel";
import Button from "@/components/ui/Button";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import { useThrowLater } from "@/lib/api/serverState";
import type { NexusPage } from "@/lib/nexus/model";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
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
      return <CaptureToday page={page} controller={controller} />;
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

/** A note whose words are not saved on this device yet: the one interrupt, until it commits. */
function CaptureToday({ page, controller }: { page: Extract<NexusPage, { kind: "CaptureToday" }>; controller: NexusController }) {
  const copy = useCopyFeedback(page.text);
  const { say } = useOutcome();
  const throwLater = useThrowLater();
  const running = page.submit.kind === "Running";
  const atRisk = (page.submit.kind === "Running" || page.submit.kind === "Retryable") && page.submit.failure?.kind === "AtRisk";
  const retry = () => controller.retryCapture("default");
  const copyText = () => void copy.copy(page.text).catch((error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError) say({ fact: "copying isn’t available here.", reason: "select the text and copy it." });
    else throwLater({ error });
  });
  return (
    <section className={styles.page}>
      <Header title="add to today" onBack={controller.back} />
      <p>{page.text}</p>
      <Button aria-busy={running || undefined} aria-disabled={page.submit.kind !== "Retryable" || undefined} onClick={retry}>retry</Button>
      {atRisk ? <Hold id={page.noteId} risk line={{ fact: "this note isn’t saved yet." }} verbs={[
        { label: "retry", commandKey: `retry capture ${page.noteId}`, run: retry, busy: running },
        { label: "copy text", commandKey: `copy capture ${page.noteId}`, run: copyText, copied: copy.occurrence ?? undefined },
      ]} /> : null}
    </section>
  );
}

export default function NexusPages({ controller, mobile }: { controller: NexusController; mobile: boolean }) {
  return (
    <>
      <Page controller={controller} mobile={mobile} />
      <div className="sr-only" role="status" aria-label="Nexus status" aria-live="polite">
        {controller.reorderSpeech}
      </div>
    </>
  );
}
