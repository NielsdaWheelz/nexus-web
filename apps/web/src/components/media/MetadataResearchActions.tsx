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
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  METADATA_REVIEW_HELP,
  metadataResearchLabel,
} from "@/lib/media/mediaMetadataCopy";
import {
  requestMetadataResearch,
  submitMetadataResultReview,
} from "@/lib/media/mediaMetadataOperations";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";

/** History submits its inspected job directly; current menu capability is unrelated. */
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
    if (pending) return;
    const heldFocus = document.activeElement === trigger;
    const paneId =
      trigger.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
    setPending(true);
    try {
      await submitMetadataResultReview(mediaId, jobId);
      // Review removes this control from current and historical projections.
      // Move keyboard focus before the refreshed row disappears; never steal it.
      if (
        heldFocus &&
        (document.activeElement === trigger ||
          document.activeElement === document.body)
      ) {
        findPaneLandmarkFocusTarget(paneId)?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      if (isApiError(error) && !isSameSystemApiDefect(error)) {
        feedback.publish({
          kind: "Hud",
          content: {
            tone: "Danger",
            title: "could not confirm review",
            message: error.message,
            requestId: error.requestId,
          },
        });
      } else fail({ error });
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
 * Research from the identity this view shows (its own `retry`), run as the
 * menu's verb: the same busy key, failure copy and admission in lib/media. A
 * title blocked on missing x source context offers the media's own source
 * remedy (refresh, retry or repair), read from its verbs while it is needed.
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
  const reviewable =
    operation !== null &&
    operation.status === "no_findings" &&
    operation.reviewed_at === null;
  const remedyNeeded =
    (!primaryOnly || !reviewable) &&
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
  const research = (trigger: HTMLButtonElement) => {
    if (retry.status !== "allowed") return;
    const paneId =
      trigger.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
    run({
      ref,
      id: "RetryMetadata",
      label: metadataResearchLabel(null, retry.purpose),
      title: "",
      confirmation: null,
      tracked: true,
      execute: () =>
        requestMetadataResearch(mediaId, retry.expected_job_id, {
          feedback: ctx.feedback,
          showMetadata: () =>
            ctx.overlays.open({
              kind: "Metadata",
              mediaId,
              returnFocusTo: trigger,
              fallback: () => findPaneLandmarkFocusTarget(paneId),
            }),
        }),
    });
  };
  return (
    <>
      {reviewable ? (
        <MetadataReviewButton mediaId={mediaId} jobId={operation.job_id} />
      ) : null}
      {(!primaryOnly || !reviewable) && retry.status === "allowed" ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !ctx.online}
          title={ctx.online ? undefined : BLOCKED_COPY.RequiresOnline}
          onClick={(event) => research(event.currentTarget)}
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
