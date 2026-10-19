"use client";

import { useEffect, useState } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { BLOCKED_COPY } from "@/lib/actions/catalog";
import {
  useActionRuntime,
  useBusyActionIds,
} from "@/lib/actions/ResourceActionsProvider";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import { apiTransportFeedback } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import {
  METADATA_REVIEW_HELP,
  metadataResearchLabel,
} from "@/lib/media/mediaMetadataCopy";
import { useAdmissionRecovery } from "@/lib/media/AdmissionRecoveryProvider";
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
      variant="secondary"
      size="sm"
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      title={METADATA_REVIEW_HELP}
      onClick={(event) => void review(event.currentTarget)}
    >
      mark reviewed
    </Button>
    {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" />}
    </>
  );
}

/**
 * Research from what this view shows (its `retry`), run as the menu's verb. A title
 * blocked on missing x source context offers the media's own source remedy (refresh,
 * retry or repair), read from its verbs while it is needed.
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
  const admissions = useAdmissionRecovery();
  const pending = admissions.pending("MetadataResearch", mediaId);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const ref = `media:${mediaId}`;
  const busy = useBusyActionIds(ref).has("RetryMetadata");
  const { operation, retry } = view;
  const reviewJob =
    operation?.status === "no_findings" && operation.reviewed_at === null
      ? operation.job_id
      : null;
  const remedyNeeded =
    (!primaryOnly || reviewJob === null) &&
    retry.status === "blocked" &&
    retry.reason === "source_context_missing";
  const remedies = useResourceActionMenu(remedyNeeded ? ref : null);
  const { onOpenChange } = remedies;
  useEffect(() => {
    if (!remedyNeeded) return;
    onOpenChange(true);
    return () => onOpenChange(false);
  }, [onOpenChange, remedyNeeded]);
  const sourceRemedy = remedies.options.find(
    (action) =>
      action.kind === "command" &&
      !action.disabled &&
      (action.id === "RefreshSource" ||
        action.id === "RetrySource" ||
        action.id === "RepairSource"),
  );
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
      tracked: true,
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
      {reviewJob !== null ? (
        <MetadataReviewButton mediaId={mediaId} jobId={reviewJob} />
      ) : null}
      {pending !== null ? (
        <Button variant="secondary" size="sm"
          aria-busy={pending.kind === "Sending" || undefined}
          aria-disabled={busy || pending.kind === "Sending" ||
            (pending.kind === "Blocked" && !pending.canConfirm) || undefined}
          title={pending.kind === "Blocked" ? pending.content.message : undefined}
          onClick={(event) => {
            if (busy || pending.kind === "Sending" ||
              (pending.kind === "Blocked" && !pending.canConfirm)) return;
            const trigger = event.currentTarget;
            run({ ref, id: "RetryMetadata", label: "confirm request", title: "", confirmation: null, tracked: true,
              execute: () => landing(trigger, () => pending.kind === "Cleanup"
                ? admissions.retryCleanup(pending.key) : admissions.confirm(pending.key)),
            });
          }}
        >{pending.kind === "Cleanup" ? "retry cleanup" : "confirm request"}</Button>
      ) : retry.status === "allowed" && (!primaryOnly || reviewJob === null) ? (
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={busy || !ctx.online || undefined}
          aria-busy={busy || undefined}
          title={ctx.online ? undefined : BLOCKED_COPY.RequiresOnline}
          onClick={(event) => { if (!busy && ctx.online) research(event.currentTarget, retry); }}
        >
          {metadataResearchLabel(operation, retry.purpose)}
        </Button>
      ) : null}
      {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" />}
      {remedyNeeded && sourceRemedy?.kind === "command" ? (
        <Button
          variant="secondary"
          size="sm"
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
