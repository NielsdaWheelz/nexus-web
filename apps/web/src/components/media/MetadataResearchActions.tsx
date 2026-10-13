"use client";

import { useMemo, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { publishImportsInvalidation } from "@/lib/imports/api";
import {
  METADATA_REVIEW_HELP,
  metadataResearchLabel,
} from "@/lib/media/mediaMetadataCopy";
import {
  reconnectMetadataOperations,
  submitMetadataResultReview,
} from "@/lib/media/mediaMetadataOperations";
import { canonicalResourceRef } from "@/lib/sharing/targets";
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

/** Same admissions and busy state as the media menu, with contextual copy. */
export default function MetadataResearchActions({
  mediaId,
  view,
  primaryOnly = false,
}: {
  readonly mediaId: string;
  readonly view: Schema<"MetadataEnrichmentView">;
  readonly primaryOnly?: boolean;
}) {
  const subject = useMemo(
    () => ({ ref: canonicalResourceRef({ scheme: "media", id: mediaId }) }),
    [mediaId],
  );
  const model = useResourceActionMenuModel(subject);
  const retry = model.descriptors.find(
    (action) => action.id === "ResourceOperation.Media.RetryMetadata",
  );
  const capability = model.capabilities.find(
    (candidate) => candidate.kind === "RetryMetadata",
  );
  const currentRetry =
    capability?.kind === "RetryMetadata" ? capability.retry : undefined;
  const expected =
    view.retry.status === "allowed" ? view.retry.expected_job_id : undefined;
  const offered =
    currentRetry?.status === "allowed"
      ? currentRetry.expected_job_id
      : undefined;
  const matches =
    currentRetry?.purpose === view.retry.purpose &&
    expected !== undefined &&
    offered !== undefined &&
    expected === offered;
  const operation = view.operation;
  const sourceRemedy =
    view.retry.status === "blocked" &&
    view.retry.reason === "source_context_missing"
      ? model.descriptors.find(
          (action) =>
            action.kind === "command" &&
            !action.disabled &&
            (action.id === "ResourceOperation.Media.RefreshSource" ||
              action.id === "ResourceOperation.Media.RetryProcessing" ||
              action.id === "ResourceOperation.Media.RepairSource"),
        )
      : undefined;
  const reviewable =
    operation !== null &&
    operation.status === "no_findings" &&
    operation.reviewed_at === null;
  return (
    <>
      {reviewable ? (
        <MetadataReviewButton
          mediaId={mediaId}
          jobId={operation.job_id}
        />
      ) : null}
      {(!primaryOnly || !reviewable) &&
      !model.metadataRequestPending &&
      view.retry.status === "allowed" &&
      model.status === "Ready" &&
      !matches ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            publishImportsInvalidation();
            reconnectMetadataOperations(mediaId);
            model.refresh();
          }}
        >
          refresh status
        </Button>
      ) : (!primaryOnly || !reviewable) &&
        (view.retry.status === "allowed" || model.metadataRequestPending) &&
        retry?.kind === "command" ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={retry.disabled}
          onClick={(event) => retry.onSelect({ triggerEl: event.currentTarget })}
        >
          {model.metadataRequestPending
            ? retry.label
            : metadataResearchLabel(operation, view.retry.purpose)}
        </Button>
      ) : null}
      {(!primaryOnly || !reviewable) && sourceRemedy?.kind === "command" ? (
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
