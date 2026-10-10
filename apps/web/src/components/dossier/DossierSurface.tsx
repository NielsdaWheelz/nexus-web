"use client";

import { useState, type ReactNode, type RefObject } from "react";
import { RotateCcw, X } from "lucide-react";
import DossierDocument from "@/components/dossier/DossierDocument";
import { coverageLabel, FAILURE_COPY } from "@/components/dossier/dossierCopy";
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
        <p className={styles.note}>
          {head.kind === "Loading" ? "Loading the dossier…" : head.message}
        </p>
        {head.kind === "Failed" ? (
          <Button variant="secondary" size="sm" onClick={dossier.reload}>
            Try again
          </Button>
        ) : null}
      </div>
    );

  const { revision, active_build, last_failure, media_abstract } = head.value;
  const building = active_build.kind === "Present" ? active_build.value : null;
  const failure =
    !building && last_failure.kind === "Present" ? last_failure.value : null;
  const rev = revision.kind === "Present" ? revision.value : null;
  // The media's current abstract: subordinate to the dossier, never a build.
  const abstract =
    media_abstract.kind === "Present" ? media_abstract.value : null;
  const status = building
    ? building.phase.kind === "Present" && building.phase.value === "Suspended"
      ? "Generation stopped; it needs attention."
      : rev
        ? "Regenerating — the current dossier stays readable."
        : "Generating the dossier…"
    : failure?.status === "Cancelled"
      ? "The last generation was canceled."
      : null;
  const instruction = (failure ?? rev)?.instruction;

  return (
    <div className={styles.surface}>
      {abstract ? (
        <section className={styles.abstract} aria-label="Media abstract">
          <span className={styles.label}>
            {abstract.status === "Stale" ? "Abstract · outdated" : "Abstract"}
          </span>
          {abstract.summary_md.kind === "Present" ? (
            <>
              <MachineText origin={{ label: "Media abstract" }}>
                <MarkdownMessage content={abstract.summary_md.value} />
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
            <span className={styles.note}>
              {abstract.status === "Building" ? "Preparing…" : "Unavailable."}
            </span>
          )}
        </section>
      ) : null}
      <p role="status" className={status ? styles.banner : "sr-only"}>
        {status}
      </p>
      {failure?.failure_code.kind === "Present" ? (
        <p role="alert" className={`${styles.banner} ${styles.alert}`}>
          {FAILURE_COPY[failure.failure_code.value]}
        </p>
      ) : null}
      {building ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.action}
          onClick={dossier.cancel}
          disabled={busy === "cancel"}
          leadingIcon={<X size={16} aria-hidden="true" />}
        >
          Cancel
        </Button>
      ) : failure ? (
        <Button
          size="sm"
          className={styles.action}
          onClick={dossier.retry}
          disabled={busy !== null}
          leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
        >
          Retry
        </Button>
      ) : null}
      {dossier.error ? (
        <p role="alert" className={styles.note}>
          {dossier.error}
        </p>
      ) : null}
      {building ? null : (
        <InstructionForm
          key={failure?.handle ?? rev?.revision_ref ?? ""}
          initial={instruction?.kind === "Present" ? instruction.value : ""}
          submit={rev ? "Regenerate" : "Generate dossier"}
          disabled={busy !== null}
          onSubmit={dossier.generate}
        />
      )}
      {rev ? (
        <div>
          {rev.stale ? (
            <p className={styles.note}>
              Sources changed since this was generated — regenerate to refresh.
            </p>
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
              rev.model.kind === "Present" ? rev.model.value : null,
              rev.total_tokens.kind === "Present"
                ? `${formatDisplayNumber(rev.total_tokens.value, env)} tokens`
                : null,
              formatDisplayDate(rev.generated_at, env, { dateStyle: "medium" }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </Fact>
          {rev.instruction.kind === "Present" ? (
            <Fact label="Instruction">{rev.instruction.value}</Fact>
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
