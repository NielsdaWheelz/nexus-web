"use client";

import {
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
