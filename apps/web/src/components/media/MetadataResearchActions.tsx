"use client";

import { useEffect, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { BLOCKED_COPY } from "@/lib/actions/catalog";
import {
  useActionRuntime,
  useBusyActionIds,
} from "@/lib/actions/ResourceActionsProvider";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import {
  METADATA_REVIEW_HELP,
  metadataResearchLabel,
} from "@/lib/media/mediaMetadataCopy";
import {
  requestMetadataResearch,
  submitMetadataResultReview,
} from "@/lib/media/mediaMetadataOperations";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";

/** Where focus goes once a control leaves: its pane's landmark, else its dialog. */
function homeOf(control: HTMLElement): () => HTMLElement | null {
  const paneId = control.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
  const dialog = control.closest<HTMLElement>("[role=dialog]");
  return () => findPaneLandmarkFocusTarget(paneId) ?? dialog;
}

/** Await a control's work; by then it left (disabled meanwhile, it lost focus): go home. */
async function landing(control: HTMLElement, work: () => Promise<void>) {
  const held = document.activeElement === control;
  const home = homeOf(control);
  await work();
  const active = document.activeElement;
  if (held && (active === control || active === document.body))
    home()?.focus({ preventScroll: true });
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
  const feedback = useFeedback();
  const fail = useThrowLater();
  const review = async (trigger: HTMLButtonElement) => {
    setPending(true);
    try {
      await landing(trigger, () => submitMetadataResultReview(mediaId, jobId));
    } catch (error) {
      const modeled = modeledApiError(error, fail);
      if (modeled !== null)
        feedback.publish({
          kind: "Hud",
          content: {
            tone: "Danger",
            title: "could not confirm review",
            message: modeled.message,
            requestId: modeled.requestId,
          },
        });
    } finally {
      setPending(false);
    }
  };
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      title={METADATA_REVIEW_HELP}
      onClick={(event) => void review(event.currentTarget)}
    >
      {pending ? "marking reviewed…" : "mark reviewed"}
    </Button>
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
    const home = homeOf(trigger);
    run({
      ref,
      id: "RetryMetadata",
      label: metadataResearchLabel(null, retry.purpose),
      title: "",
      confirmation: null,
      tracked: true,
      execute: () =>
        landing(trigger, () =>
          requestMetadataResearch(mediaId, retry.expected_job_id, {
            feedback: ctx.feedback,
            showMetadata: () =>
              ctx.overlays.open({
                kind: "Metadata",
                mediaId,
                returnFocusTo: trigger,
                fallback: home,
              }),
          }),
        ),
    });
  };
  return (
    <>
      {reviewJob !== null ? (
        <MetadataReviewButton mediaId={mediaId} jobId={reviewJob} />
      ) : null}
      {retry.status === "allowed" && (!primaryOnly || reviewJob === null) ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !ctx.online}
          title={ctx.online ? undefined : BLOCKED_COPY.RequiresOnline}
          onClick={(event) => research(event.currentTarget, retry)}
        >
          {metadataResearchLabel(operation, retry.purpose)}
        </Button>
      ) : null}
      {remedyNeeded && sourceRemedy?.kind === "command" ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={(event) =>
            sourceRemedy.onSelect({ triggerEl: event.currentTarget })
          }
        >
          {sourceRemedy.label}
        </Button>
      ) : null}
    </>
  );
}
