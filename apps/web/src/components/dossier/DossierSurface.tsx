"use client";

import { useState, type ReactNode, type RefObject } from "react";
import DossierDocument from "@/components/dossier/DossierDocument";
import { coverageLabel, FAILURE_COPY } from "@/components/dossier/dossierCopy";
import { FeedbackNotice, FeedbackState, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import MachineText from "@/components/ui/MachineText";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { formatDisplayDate, formatDisplayNumber } from "@/lib/display/format";
import { useDossier, type Dossier } from "@/lib/dossiers/useDossier";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import {
  toReaderCitationData,
  type ReaderSourceTarget,
} from "@/lib/resourceGraph/citations";
import type { ResourceActivation } from "@/lib/resources/activation";
import styles from "./DossierSurface.module.css";

export type DossierCitationActivate = (
  activation: ResourceActivation,
  target: ReaderSourceTarget | null,
  disposition: { readonly kind: "Follow" | "Fork" },
) => void;

interface Commands {
  readonly onCitationActivate: DossierCitationActivate;
  readonly onViewMediaEvidence: () => void;
}

/** The inspector's Dossier tab: one subject's head. */
export function SubjectDossier({
  scheme,
  handle,
  ...commands
}: Commands & { readonly scheme: string; readonly handle: string }) {
  const dossier = useDossier({ kind: "Subject", scheme, handle });
  return <DossierSurface dossier={dossier} {...commands} />;
}

/**
 * Every visible dossier state. One polite status line carries progress and
 * cancellation; a failure is an alert with Retry; neither moves focus. The
 * instruction field shows whenever no build runs, holding the last instruction.
 */
export default function DossierSurface({
  dossier,
  onCitationActivate,
  onViewMediaEvidence,
  articleRef,
}: Commands & {
  readonly dossier: Dossier;
  readonly articleRef?: RefObject<HTMLElement | null>;
}) {
  const env = useRenderEnvironment();
  const { head, busy } = dossier;
  if (head.kind !== "Ready")
    return (
      <div className={styles.surface}>
        <FeedbackState
          content={{ tone: head.kind === "Failed" ? "Warning" : "Neutral", title: head.kind === "Loading" ? "loading the dossier…" : "dossier couldn’t load", message: head.kind === "Failed" ? head.message : undefined }}
          announcement="Polite"
          actions={head.kind === "Failed" ? [{ label: "retry loading", onClick: dossier.reload, busy: head.retrying }] : undefined}
        />
      </div>
    );

  const { revision, active_build, last_failure, media_abstract } = head.value;
  const building = active_build;
  const failure = building ? null : last_failure;
  const rev = revision;
  // The media's current abstract: subordinate to the dossier, never a build.
  const abstract = media_abstract;
  const status = building
    ? building.phase === "Suspended"
      ? "Generation stopped; it needs attention."
      : rev
        ? "Regenerating — the current dossier stays readable."
        : "Generating the dossier…"
    : null;
  const instruction = (failure ?? rev)?.instruction;

  return (
    <div className={styles.surface}>
      {head.refreshFailure ? <FeedbackNotice
        content={{ tone: "Warning", title: "dossier couldn’t refresh", message: head.refreshFailure }}
        announcement="Polite"
        actions={[{ label: "retry refresh", onClick: dossier.reload, busy: head.refreshing }]}
      /> : null}
      {abstract ? (
        <section className={styles.abstract} aria-label="Media abstract">
          <span className={styles.label}>
            {abstract.status === "Stale" ? "Abstract · outdated" : "Abstract"}
          </span>
          {abstract.summary_md !== null ? (
            <>
              <MachineText origin={{ label: "Media abstract" }}>
                <MarkdownMessage content={abstract.summary_md} />
              </MachineText>
              <Button
                variant="ghost"
                size="sm"
                className={styles.action}
                onClick={onViewMediaEvidence}
              >
                View evidence
              </Button>
            </>
          ) : (
            <FeedbackStatus content={{ tone: "Neutral", title: abstract.status === "Building" ? "abstract is preparing…" : "abstract unavailable" }} announcement="None" />
          )}
        </section>
      ) : null}
      {status ? <FeedbackStatus
        content={{ tone: "Neutral", title: status }}
        announcement="Polite"
        actions={building ? [{ label: "cancel generation", onClick: dossier.cancel, busy: busy === "cancel" }] : undefined}
      /> : null}
      {failure ? <FeedbackNotice
        content={{ tone: failure.status === "Cancelled" ? "Neutral" : "Warning", title: failure.status === "Cancelled" ? "generation canceled" : "dossier generation failed", message: failure.failure_code != null ? FAILURE_COPY[failure.failure_code] : undefined }}
        announcement="Polite"
        actions={[{ label: "start a new generation", onClick: dossier.retry, busy: busy !== null }]}
      /> : null}
      {dossier.error ? <FeedbackNotice content={{ tone: "Warning", title: "dossier change not confirmed", message: dossier.error }} announcement="Assertive" /> : null}
      {building ? null : (
        <InstructionForm
          key={failure?.handle ?? rev?.revision_ref ?? ""}
          initial={instruction ?? ""}
          submit={rev ? "Regenerate" : "Generate dossier"}
          disabled={busy !== null}
          onSubmit={dossier.generate}
        />
      )}
      {rev ? (
        <div>
          {rev.stale ? (
            <FeedbackStatus content={{ tone: "Neutral", title: "sources changed since this was generated", message: "regenerate to refresh the dossier." }} announcement="None" />
          ) : null}
          <MachineText origin={{ label: "Dossier" }}>
            <DossierDocument
              html={rev.content_html}
              citations={rev.citations}
              articleRef={articleRef}
              onCitation={(citation, disposition) => {
                const { activation, target } = toReaderCitationData(citation);
                onCitationActivate(activation, target, { kind: disposition });
              }}
            />
          </MachineText>
          <Fact label="Coverage">{coverageLabel(rev.coverage)}</Fact>
          <Fact label="Provenance">
            {[
              rev.by_viewer ? "You" : "A library member",
              rev.model,
              rev.total_tokens !== null
                ? `${formatDisplayNumber(rev.total_tokens, env)} tokens`
                : null,
              formatDisplayDate(rev.generated_at, env, { dateStyle: "medium" }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </Fact>
          {rev.instruction !== null ? (
            <Fact label="Instruction">{rev.instruction}</Fact>
          ) : null}
        </div>
      ) : building ? null : (
        <p className={styles.note}>
          No dossier yet. Generate one to synthesize this subject.
        </p>
      )}
    </div>
  );
}

function InstructionForm(props: {
  readonly initial: string;
  readonly submit: string;
  readonly disabled: boolean;
  readonly onSubmit: (instruction: string | null) => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(draft.trim() || null);
      }}
    >
      <label className={styles.field}>
        <span>Optional instruction</span>
        <Input
          size="sm"
          maxLength={4000}
          value={draft}
          disabled={props.disabled}
          placeholder="What should this dossier emphasize?"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </label>
      <Button type="submit" size="sm" disabled={props.disabled}>
        {props.submit}
      </Button>
    </form>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p
      className={styles.fact}
      role="note"
      aria-label={`Dossier ${label.toLowerCase()}`}
    >
      <span className={styles.label}>{label}</span>
      {children}
    </p>
  );
}
