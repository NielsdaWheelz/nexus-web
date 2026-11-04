"use client";

import { useEffect, useId, useMemo, useRef } from "react";
import { useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { useTransportVerbs } from "@/components/feedback/stage";
import { Fact, Failed, VerbControl } from "@/components/feedback/Fact";
import { sentence } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import { BLOCKED_COPY } from "@/lib/actions/catalog";
import { useActionRuntime, useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import { ResourceActionFailure, type ActionCommand } from "@/lib/actions/project";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import { isApiError } from "@/lib/api/client";
import { admissionTransport, TRANSPORT_LINES } from "@/lib/api/failure";
import type { Schema } from "@/lib/api/wire";
import {
  METADATA_REVIEW_HELP,
  metadataResearchLabel,
} from "@/lib/media/mediaMetadataCopy";
import { useMediaAdmissions } from "@/lib/media/admissions";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { submitMetadataResultReview } from "@/lib/media/mediaMetadataOperations";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";

/** Repair focus only when the control owning it actually left the document. */
async function landing(control: HTMLElement, work: () => Promise<void>) {
  const held = document.activeElement === control;
  const paneId = control.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
  const dialog = control.closest<HTMLElement>("[role=dialog]");
  await work();
  const active = document.activeElement;
  const target = findPaneLandmarkFocusTarget(paneId) ?? dialog;
  if (held && !control.isConnected && active === document.body && target?.isConnected)
    target.focus({ preventScroll: true });
}

/** Review one exact no-findings job through the account's retained action owner. */
export function MetadataReviewButton({ mediaId, jobId }: { readonly mediaId: string; readonly jobId: string }) {
  const { run } = useActionRuntime();
  const contextId = useId();
  const fact = "couldn’t mark this reviewed.";
  const ref = `media:${mediaId}`;
  const busy = useBusyActionIds(ref).has("ReviewMetadataResult");
  const resendFeedback = useResendFeedback();
  const command = useMemo<ActionCommand>(() => ({ ref, id: "ReviewMetadataResult", label: "mark reviewed", feedbackLabel: "mark reviewed", title: "",
    confirmation: null, tracked: true, rawWrite: true,
    execute: acknowledged => submitMetadataResultReview(mediaId, jobId, acknowledged).catch(error => {
      if (isApiError(error) && (error.code === "E_MEDIA_NOT_FOUND" || error.code === "E_NOT_FOUND"))
        throw new ResourceActionFailure({ fact, reason: "this result isn’t available." });
      if (isApiError(error) && error.code === "E_RESOURCE_CONFLICT") throw new ResourceActionFailure({ fact });
      throw error;
    }),
  }), [ref, mediaId, jobId]);
  const presentation = resendFeedback({ line: { fact: "metadata review." }, resend: { label: "mark reviewed", commandKey: `review metadata:${mediaId}:${jobId}`,
    run: () => run(command), busy } });
  const line = presentation.line.reason ? presentation.line : { fact: METADATA_REVIEW_HELP };
  return <>
    <span id={contextId} className="sr-only">{sentence(line)}</span>
    {presentation.verbs === null ? <div data-metadata-action=""><Fact line={line} /></div>
      : <span data-metadata-action=""><VerbControl contextId={contextId} verb={presentation.verbs[0]} /></span>}
  </>;
}

/**
 * Research from what this view shows (its `retry`), run as the menu's verb. A title
 * blocked on missing x source context offers the media's own source remedy (refresh,
 * retry or repair), read from its verbs while it is needed.
 * Hosts promote data-metadata-action controls; data-metadata-feedback stays visible.
 */
export default function MetadataResearchActions({
  mediaId,
  view,
  primaryOnly = false,
}: {
  readonly mediaId: string;
  readonly view: Schema<"MetadataEnrichmentView">;
  readonly primaryOnly?: boolean;
}) {
  const { ctx, run } = useActionRuntime();
  const reasonId = useId();
  const transportVerbs = useTransportVerbs();
  const admissions = useMediaAdmissions();
  const pending = admissions.pending("MetadataResearch", mediaId);
  const { say, fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const heldBack = admissionTransport(useRemoteAdmission());
  const ref = `media:${mediaId}`;
  const { operation, retry } = view;
  const reviewJob =
    operation?.status === "no_findings" && operation.reviewed_at === null
      ? operation.job_id
      : null;
  const remedyNeeded =
    (!primaryOnly || reviewJob === null) &&
    retry.status === "blocked" &&
    retry.reason === "source_context_missing";
  const remedies = useResourceActions(remedyNeeded ? ref : null);
  const { prepare, state } = remedies;
  const remedyRequest = useRef<AbortController | null>(null);
  const remedyFailure = state?.kind === "Failed" ? { error: state.error } : state?.kind === "Loading" ? state.failure : null;
  useEffect(() => {
    if (!remedyNeeded) return;
    const controller = new AbortController();
    remedyRequest.current = controller;
    prepare(controller.signal);
    return () => {
      if (remedyRequest.current === controller) remedyRequest.current = null;
      controller.abort();
    };
  }, [prepare, remedyNeeded]);
  const sourceRemedy = state?.kind === "Ready" ? state.options.find(
    (action) =>
      action.kind === "command" &&
      !action.disabled &&
      (action.id === "RefreshSource" ||
        action.id === "RetrySource" ||
        action.id === "RepairSource"),
  ) : undefined;
  const research = (
    trigger: HTMLButtonElement,
    retry: Schema<"MetadataRetryAllowed">,
  ) => {
    run({
      ref,
      id: "RetryMetadata",
      label: metadataResearchLabel(null, retry.purpose),
      feedbackLabel: metadataResearchLabel(null, retry.purpose).toLowerCase(),
      title: "",
      confirmation: null,
      tracked: false,
      execute: () => landing(trigger, async () => {
        const result = await admissions.admit({ kind: "MetadataResearch", mediaId,
          request: { expected_job_id: retry.expected_job_id } });
        if (result.kind !== "LocalFailure") return;
        if (result.error) fail(result.error, result.line.fact);
        else say(result.line, result.verbs ?? undefined);
      }),
    });
  };
  const pendingFeedback = pending === null ? null : resendFeedback({ line: { fact: "metadata search" },
    resend: { label: "retry", commandKey: `RetryMetadata:${pending.key}`, busy: pending.kind === "sending",
      run: () => run({ ref, id: "RetryMetadata", label: "retry", feedbackLabel: "retry", title: "", confirmation: null, tracked: false,
        execute: () => admissions.retry(pending.key) }) } });
  return (
    <>
      <span id={reasonId} className="sr-only">{pendingFeedback !== null ? sentence(pendingFeedback.line) : ctx.online ? "metadata search" : BLOCKED_COPY.RequiresOnline}</span>
      {reviewJob !== null ? (
        <MetadataReviewButton key={reviewJob} mediaId={mediaId} jobId={reviewJob} />
      ) : null}
      {pendingFeedback !== null ? (
        pendingFeedback.verbs === null ? null : <span data-metadata-action=""><VerbControl contextId={reasonId} verb={pendingFeedback.verbs[0]} /></span>
      ) : retry.status === "allowed" && (!primaryOnly || reviewJob === null) ? (
        <Button
          data-metadata-action=""
          aria-disabled={!ctx.online || undefined}
          aria-describedby={!ctx.online ? reasonId : undefined}
          tooltip={ctx.online ? undefined : { text: BLOCKED_COPY.RequiresOnline }}
          onClick={(event) => { if (ctx.online) research(event.currentTarget, retry); }}
        >
          {metadataResearchLabel(operation, retry.purpose)}
        </Button>
      ) : null}
      {remedyNeeded && remedyFailure ? remedyFailure.error
        ? <Failed error={remedyFailure.error} noun="source actions" retry={{ busy: state?.kind === "Loading", run: () => {
          const request = remedyRequest.current;
          if (request !== null && !request.signal.aborted) prepare(request.signal);
        } }} />
        // no request went out: admission says why, once a reason is true.
        : <Fact line={heldBack === null ? { fact: "couldn’t load source actions." } : TRANSPORT_LINES[heldBack].read("source actions")}
          verbs={heldBack === null ? undefined : transportVerbs(heldBack) ?? undefined} /> : null}
      {remedyNeeded && sourceRemedy?.kind === "command" ? (
        <Button
          data-metadata-action=""
          onClick={(event) => {
            const detail = prepareActionSelect(event, event.currentTarget);
            if (detail) sourceRemedy.onSelect(detail);
          }}
          onKeyDown={(event) => {
            const detail = prepareActionSelect(event, event.currentTarget);
            if (detail) sourceRemedy.onSelect(detail);
          }}
        >
          {sourceRemedy.label}
        </Button>
      ) : null}
    </>
  );
}
