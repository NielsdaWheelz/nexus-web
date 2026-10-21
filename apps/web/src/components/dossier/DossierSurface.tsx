"use client";

import { useEffect, type ReactNode, type RefObject } from "react";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { usePaneVisitWorkOwner, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
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
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import type { TargetLinkActivationResult } from "@/lib/panes/targetLinkActivation";
import styles from "./DossierSurface.module.css";

interface Commands {
  readonly mediaEvidence: { href: string; activate(event: TargetActivationEvent): TargetLinkActivationResult } | null;
}

/** The inspector's Dossier tab: one subject's head. */
export function SubjectDossier({
  scheme,
  handle,
  ...commands
}: Commands & { readonly scheme: string; readonly handle: string }) {
  const dossier = useDossier({ kind: "Subject", scheme, handle });
  return <DossierSurface dossier={dossier} draftKey={`${scheme}:${handle}`} {...commands} />;
}

/**
 * Every visible dossier state. One polite status line carries progress and
 * cancellation; a failure stays near the instruction form; neither moves focus. The
 * instruction field shows whenever no build runs, holding the last instruction.
 */
export default function DossierSurface({
  dossier,
  mediaEvidence,
  articleRef,
  draftKey,
}: Commands & {
  readonly dossier: Dossier;
  readonly draftKey: string;
  readonly articleRef?: RefObject<HTMLElement | null>;
}) {
  const { head } = dossier;
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

  return <ReadyDossier dossier={dossier} head={head} mediaEvidence={mediaEvidence} articleRef={articleRef} draftKey={draftKey} />;
}

function ReadyDossier({ dossier, head, mediaEvidence, articleRef, draftKey }: Commands & {
  dossier: Dossier; head: Extract<Dossier["head"], { kind: "Ready" }>;
  articleRef?: RefObject<HTMLElement | null>; draftKey: string;
}) {
  const env = useRenderEnvironment();
  const busy = dossier.busy;
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
  const instruction = (failure ?? rev)?.instruction ?? "";
  const instructionKey = failure?.handle ?? rev?.revision_ref ?? null;
  const draft = useResourceDraft<{
    text: string; baseline: string; loadedKey: string | null; sending: boolean;
    request: { id: string; instruction: string | null; text: string } | null;
  }>(`Dossier.Instruction:${draftKey}`, () => ({ text: instruction, baseline: instruction, loadedKey: instructionKey, request: null, sending: false }),
    value => ({ changed: value.text !== value.baseline, unconfirmed: false, stopsBrowserWork: false }));
  const { read: readDraft, set: setDraft, subscribe, owner } = draft;
  const requestOwner = `${owner}:request`;
  usePaneVisitWorkOwner({ id: requestOwner, scope: usePaneVisitWorkScope(), subscribe,
    read: () => ({ changed: false, unconfirmed: readDraft().request !== null, stopsBrowserWork: false }),
  });
  const guard = useWorkGuard();
  const { ctx } = useActionRuntime();
  useEffect(() => {
    const current = readDraft();
    if (current.loadedKey !== instructionKey && current.request === null && current.text === current.baseline)
      setDraft({ ...current, text: instruction, baseline: instruction, loadedKey: instructionKey });
  }, [instruction, instructionKey, readDraft, setDraft]);
  const submitInstruction = async () => {
    const current = readDraft();
    if (current.sending) return;
    const instruction = current.text.trim() || null;
    const previous = current.request;
    if (previous && previous.instruction !== instruction && !guard.confirmLoss({ scopes: [], ownerIds: [requestOwner] })) return;
    const request = previous?.instruction === instruction ? previous : { id: crypto.randomUUID(), instruction, text: current.text };
    setDraft({ ...current, request, sending: true });
    const signal = ctx.sessionSignal();
    const outcome = await dossier.generate(request.instruction, request.id);
    if (signal.aborted) return;
    setDraft(value => {
      if (value.request !== request) return value;
      if (outcome === "accepted") {
        const baseline = request.instruction ?? "";
        return { ...value, text: value.text === request.text ? baseline : value.text, baseline, request: null, sending: false };
      }
      return { ...value, request: outcome === "refused" && previous === null ? null : request, sending: false };
    });
  };

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
              {mediaEvidence ? <Button asChild variant="ghost" size="sm" className={styles.action}>
                <a href={mediaEvidence.href} data-workspace-rich-target="true" onClick={mediaEvidence.activate} onKeyDown={mediaEvidence.activate}>View evidence</a>
              </Button> : null}
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
      /> : null}
      {dossier.error ? <FeedbackNotice content={{ tone: "Warning", title: "dossier change not confirmed", message: dossier.error }} announcement="Assertive" /> : null}
      {building ? null : (
        <InstructionForm
          value={draft.value.text}
          onChange={text => setDraft(value => ({ ...value, text }))}
          submit={rev ? "Regenerate" : "Generate dossier"}
          disabled={busy !== null || draft.value.sending}
          onSubmit={() => void submitInstruction()}
        />
      )}
      {rev ? (
        <div>
          {rev.stale ? (
            <FeedbackStatus content={{ tone: "Neutral", title: "sources changed since this was generated", message: "regenerate to refresh the dossier." }} announcement="None" />
          ) : null}
          <MachineText origin={{ label: "prepared by the librarian" }}>
            <DossierDocument
              html={rev.content_html}
              citations={rev.citations}
              articleRef={articleRef}

            />
          </MachineText>
          <Fact label="Coverage">{coverageLabel(rev.coverage)}</Fact>
          <Fact label="Provenance">
            {[
              rev.by_viewer ? "requested by you" : "requested by a library member",
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
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly submit: string;
  readonly disabled: boolean;
  readonly onSubmit: () => void;
}) {
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <label className={styles.field}>
        <span>Optional instruction</span>
        <Input
          size="sm"
          maxLength={4000}
          value={props.value}
          disabled={props.disabled}
          placeholder="What should this dossier emphasize?"
          onChange={(event) => props.onChange(event.currentTarget.value)}
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
