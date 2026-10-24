"use client";

import { installedApp } from "@/lib/native/admission";
import { useEffect, useId, useState } from "react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { BLOCKED_COPY } from "@/lib/actions/catalog";
import {
  useActionRuntime,
} from "@/lib/actions/ResourceActionsProvider";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import { apiTransportFeedback, isStaleBuild } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import {
  METADATA_REVIEW_HELP,
  metadataResearchLabel,
} from "@/lib/media/mediaMetadataCopy";
import { useMediaAdmissions } from "@/lib/media/admissions";
import { submitMetadataResultReview } from "@/lib/media/mediaMetadataOperations";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";

/** Where focus goes once a control leaves: its pane's landmark, else its dialog. */
function homeOf(control: HTMLElement): () => HTMLElement | null {
  const paneId = control.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
  const dialog = control.closest<HTMLElement>("[role=dialog]");
  return () => findPaneLandmarkFocusTarget(paneId) ?? dialog;
}

/** Repair focus only when the control owning it actually left the document. */
async function landing(control: HTMLElement, work: () => Promise<void>) {
  const held = document.activeElement === control;
  const home = homeOf(control);
  await work();
  const active = document.activeElement;
  const target = home();
  if (held && !control.isConnected && active === document.body && target?.isConnected)
    target.focus({ preventScroll: true });
}

/** Review one exact no-findings job (history passes its own; the menu is unrelated). */
export function MetadataReviewButton({
  mediaId,
  jobId,
}: {
  readonly mediaId: string;
  readonly jobId: string;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const fail = useThrowLater();
  const review = async (trigger: HTMLButtonElement) => {
    if (pending) return;
    setPending(true);
    try {
      await landing(trigger, () => submitMetadataResultReview(mediaId, jobId));
      setFailure(null);
    } catch (error) {
      const modeled = modeledApiError(error, fail);
      if (modeled !== null) {
        const content = apiTransportFeedback(modeled, "couldn't confirm this review.") ??
          (modeled.code === "E_MEDIA_NOT_FOUND" || modeled.code === "E_NOT_FOUND"
            ? { tone: "Warning" as const, title: "this result is no longer available", requestId: modeled.requestId }
            : modeled.code === "E_RESOURCE_CONFLICT"
              ? { tone: "Warning" as const, title: "this result changed", message: "only a result with no findings can be marked reviewed.", requestId: modeled.requestId }
              : null);
        if (content === null) fail({ error });
        else setFailure(content);
      }
    } finally {
      setPending(false);
    }
  };
  return (
    <>
    <Button
      data-metadata-action=""
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      tooltip={{ text: METADATA_REVIEW_HELP }}
      onClick={(event) => void review(event.currentTarget)}
    >
      mark reviewed
    </Button>
    {failure === null ? null : <div data-metadata-feedback=""><FeedbackNotice content={failure} announcement="Polite" /></div>}
    </>
  );
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
  const admissions = useMediaAdmissions();
  const pending = admissions.pending("MetadataResearch", mediaId);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
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
  const [remedyAttempt, setRemedyAttempt] = useState(0);
  useEffect(() => {
    if (!remedyNeeded) return;
    const controller = new AbortController();
    prepare(controller.signal);
    return () => controller.abort();
  }, [prepare, remedyNeeded, remedyAttempt]);
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
      title: "",
      confirmation: null,
      tracked: false,
      execute: () => landing(trigger, async () => {
        const result = await admissions.admit({ kind: "MetadataResearch", mediaId,
          request: { expected_job_id: retry.expected_job_id } });
        if (result.kind !== "OwnerGone")
          setFailure(result.kind === "LocalFailure" ? result.content : null);
      }),
    });
  };
  return (
    <>
      {!ctx.online ? <span id={reasonId} className="sr-only">{BLOCKED_COPY.RequiresOnline}</span> : null}
      {reviewJob !== null ? (
        <MetadataReviewButton mediaId={mediaId} jobId={reviewJob} />
      ) : null}
      {pending !== null ? (
        isStaleBuild(pending.error) ? <Button data-metadata-action="" aria-disabled={installedApp || undefined}
          tooltip={installedApp ? { text: "install the current nexus apk, then reopen the app." } : undefined}
          onClick={() => { if (!installedApp) window.location.reload(); }}>
          {installedApp ? "update nexus" : "reload app"}
        </Button> :
        <Button
          data-metadata-action=""
          aria-busy={pending.kind === "sending" || undefined}
          aria-disabled={pending.kind === "sending" || !ctx.online || undefined}
          aria-describedby={!ctx.online ? reasonId : undefined}
          tooltip={ctx.online ? undefined : { text: BLOCKED_COPY.RequiresOnline }}
          onClick={(event) => {
            if (pending.kind === "sending" || !ctx.online) return;
            const trigger = event.currentTarget;
            run({ ref, id: "RetryMetadata", label: "retry same request", title: "", confirmation: null, tracked: false,
              execute: () => landing(trigger, () => admissions.retry(pending.key)),
            });
          }}
        >retry same request</Button>
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
      {failure !== null || remedyNeeded && (state === null || state.kind === "Loading" || state.kind === "Failed") ? <div data-metadata-feedback="">
      {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" />}
      {remedyNeeded && (state === null || state.kind === "Loading") ? <FeedbackStatus
        content={{ tone: "Neutral", title: "loading actions…" }} announcement="Polite"
      /> : null}
      {remedyNeeded && state?.kind === "Failed" ? <FeedbackNotice content={state.feedback} announcement="Polite"
        actions={[{ label: "retry", onClick: () => setRemedyAttempt((attempt) => attempt + 1) }]} /> : null}
      </div> : null}
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
