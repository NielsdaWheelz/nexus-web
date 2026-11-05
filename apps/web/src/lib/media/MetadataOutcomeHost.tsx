"use client";

// The current action owner presents receipts taken from account-owned observation.
// It retains no progress row or history; result activation captures focus when clicked.
import { useEffect } from "react";
import { useStage, useTransportVerbs, type Address } from "@/components/feedback/stage";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { invalidateReads } from "@/lib/api/changes";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { useThrowLater } from "@/lib/api/serverState";
import { metadataObservationLine, metadataResultLine } from "@/lib/media/mediaMetadataCopy";
import { presentMetadataFeedback, reconnectMetadataOperation, useMetadataFeedback } from "@/lib/media/mediaMetadataOperations";
import { findActivePaneLandmarkFocusTarget, findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";

export default function MetadataOutcomeHost() {
  const version = useMetadataFeedback();
  const stage = useStage();
  const transportVerbs = useTransportVerbs();
  const { ctx } = useActionRuntime();
  const throwLater = useThrowLater();
  useEffect(() => {
    try {
      presentMetadataFeedback(feedback => {
        if (!ctx.isActive() || ctx.accountId !== feedback.accountId) return;
        feedback.retract();
        const address: Address = feedback.originPaneId === null ? { kind: "Workspace" }
          : { kind: "Pane", paneId: feedback.originPaneId };
        if (feedback.kind === "Interrupted") {
          const fact = metadataObservationLine(feedback.title, feedback.purpose);
          const transport = transportOf(feedback.error);
          const line = feedback.error.code === "E_MEDIA_NOT_FOUND" ? { ...fact, reason: "this item isn’t available to you." }
            : feedback.error.code === "E_NOT_FOUND" ? { ...fact, reason: "this update isn’t available." }
              : TRANSPORT_LINES[transport].command(fact.fact);
          stage.say({ address, line, verbs: transportVerbs(transport, { retry: {
            label: "check status", commandKey: `metadata status:${feedback.mediaId}:${feedback.jobId}`,
            run: () => { if (ctx.isActive()) reconnectMetadataOperation(feedback.mediaId, feedback.jobId); },
          } }) });
          return;
        }
        invalidateReads("Metadata");
        stage.say({ address, line: metadataResultLine(feedback.operation, feedback.title), verbs: [{
          label: "view result", commandKey: `metadata result:${feedback.mediaId}:${feedback.jobId}`,
          run: () => {
            if (!ctx.isActive()) return;
            const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const fallback = () => findPaneChromeFocusTarget(feedback.originPaneId)
              ?? findPaneLandmarkFocusTarget(feedback.originPaneId) ?? findActivePaneLandmarkFocusTarget();
            ctx.overlays.open({ kind: "Metadata", subject: { kind: "Media", mediaId: feedback.mediaId, jobId: feedback.jobId },
              returnFocusTo: trigger, fallback }, { anchor: () => trigger, returnFocusFallback: fallback });
          },
        }] });
      });
    } catch (error) { throwLater({ error }); }
  }, [version, ctx, stage, transportVerbs, throwLater]);
  return null;
}
