"use client";

import {
  hrefForNoteTarget,
  hrefForReaderTarget,
  type ReaderSourceTarget,
} from "@/lib/conversations/readerTarget";
import { setPendingNoteActivation } from "@/lib/reader/pendingNoteActivation";
import { dispatchNotePulse, dispatchReaderPulse } from "@/lib/reader/pulseEvent";

export function dispatchReaderSourceActivation(target: ReaderSourceTarget): void {
  if (target.kind === "note") {
    const notePulse = {
      blockId: target.block_id,
      startOffset: target.start_offset,
      endOffset: target.end_offset,
      snippet: target.snippet,
      highlightBehavior: target.highlight_behavior,
      focusBehavior: target.focus_behavior,
    } as const;
    dispatchNotePulse(notePulse);
    setPendingNoteActivation(notePulse);
    return;
  }

  dispatchReaderPulse({
    mediaId: target.media_id,
    evidenceSpanId: target.evidence_span_id ?? undefined,
    locator: target.locator,
    snippet: target.snippet,
    highlightBehavior: target.highlight_behavior,
    focusBehavior: target.focus_behavior,
  });
}

export function hrefForReaderSourceTarget(target: ReaderSourceTarget): string {
  if (target.kind === "note") {
    return target.href ?? hrefForNoteTarget({ block_id: target.block_id });
  }
  return (
    target.href ??
    hrefForReaderTarget({
      media_id: target.media_id,
      evidence_span_id: target.evidence_span_id,
      locator: target.locator,
    })
  );
}

export function resourceRefForReaderSourceTarget(target: ReaderSourceTarget): string {
  if (target.kind === "note") {
    return `note_block:${target.block_id}`;
  }
  return `media:${target.media_id}`;
}
