"use client";

import { useCallback, useContext } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { ResourceCacheContext, type ResourceCache } from "@/lib/api/resourceCache";
import type { ReaderSourceTarget } from "./readerTarget";
import { setPendingNoteActivation } from "@/lib/reader/pendingNoteActivation";
import { dispatchMountedReaderPulse, dispatchNotePulse, dispatchReaderPulse, type ReaderPulseInput } from "@/lib/reader/pulseEvent";
import { readerSourceRangeInputBytes } from "@/lib/reader/ReaderDocumentSource";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { activateResource, type ResourceActivation } from "@/lib/resources/activation";
import type { PaneRuntimeContextValue } from "@/lib/panes/paneRuntime";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";

type ActivationInput = { activateTarget: PaneRuntimeContextValue["activateTarget"]; disposition: WorkspaceTargetDisposition };

/** Admit citation payload before a workspace activation can retire its original view. */
function activateReaderSourceTarget(activation: ResourceActivation, target: ReaderSourceTarget | null,
  input: ActivationInput, cache: ResourceCache): { kind: "Handled" | "Unhandled" } | { kind: "Capacity"; reason: "Input" | "Payload" } {
  if (target === null || target.kind === "note") {
    const handled = activateResource(activation, { labelHint: target?.label, disposition: input.disposition,
      activateTarget(request) {
        const destination = input.activateTarget(request);
        if (target === null || destination.kind === "Rejected") return;
        const pulse = { blockId: target.block_id, startOffset: target.start_offset, endOffset: target.end_offset,
          snippet: target.snippet, highlightBehavior: target.highlight_behavior, focusBehavior: target.focus_behavior };
        dispatchNotePulse(pulse); setPendingNoteActivation(pulse);
      },
    });
    return { kind: handled ? "Handled" : "Unhandled" };
  }
  if (target.locator.type === "transcript_time_range" || target.locator.type === "audio_time_range" || target.locator.type === "video_time_range") {
    const handled = activateResource(activation, { labelHint: target.label, disposition: input.disposition,
      activateTarget(request) {
        const destination = input.activateTarget(request);
        if (destination.kind === "Rejected") return;
        dispatchMountedReaderPulse({ paneId: destination.paneId, mediaId: target.media_id, locator: target.locator,
          ...(target.evidence_span_id == null ? {} : { evidenceSpanId: target.evidence_span_id }),
          snippet: target.snippet, highlightBehavior: target.highlight_behavior, focusBehavior: target.focus_behavior });
      },
    });
    return { kind: handled ? "Handled" : "Unhandled" };
  }
  if ((target.locator.type === "web_text_offsets" || target.locator.type === "epub_fragment_offsets") &&
      readerSourceRangeInputBytes(target.locator) > READER_CAPACITY.indexBytes) return { kind: "Capacity", reason: "Input" };
  const pulse: ReaderPulseInput = { mediaId: target.media_id, locator: target.locator,
    ...(target.evidence_span_id == null ? {} : { evidenceSpanId: target.evidence_span_id }),
    snippet: target.locator.type === "web_text_offsets" || target.locator.type === "epub_fragment_offsets" || target.locator.type === "pdf_page_geometry"
      ? null : target.snippet,
    highlightBehavior: target.highlight_behavior, focusBehavior: target.focus_behavior };
  const admitted = cache.retainReaderSourceInput(pulse);
  if (admitted.kind === "Capacity") return admitted;
  let delivered = false;
  try {
    const handled = activateResource(activation, { labelHint: target.label, disposition: input.disposition,
      activateTarget(request) {
        const destination = input.activateTarget(request);
        if (destination.kind === "Rejected") return;
        dispatchReaderPulse({ ...pulse, paneId: destination.paneId }, admitted.lease);
        delivered = true;
      },
    });
    return { kind: handled ? "Handled" : "Unhandled" };
  } finally { if (!delivered) admitted.lease.release(); }
}

/** True means the link event was handled, including explicit capacity refusal. */
export function useReaderSourceActivation() {
  const cache = useContext(ResourceCacheContext);
  const feedback = useFeedback();
  return useCallback((activation: ResourceActivation, target: ReaderSourceTarget | null, input: ActivationInput): boolean => {
    if (cache === null) throw new Error("Source activation requires the account resource cache");
    const result = activateReaderSourceTarget(activation, target, input, cache);
    if (result.kind !== "Capacity") return result.kind === "Handled";
    feedback.publish({ kind: "Hud", key: "reader-source-capacity", content: {
      tone: "Warning", title: result.reason === "Input" ? "This source reference is too large to open." : "There is not enough reader space to open this source.",
      message: result.reason === "Input" ? "The original reference remains available. Its quote has not been shortened."
        : "Make space, then try the original source reference again.",
    } });
    return true;
  }, [cache, feedback]);
}
