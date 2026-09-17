"use client";

import type { RetrievalLocator } from "@/lib/api/sse/locators";
import { createWindowEventChannel } from "@/lib/windowEventChannel";

export const READER_PULSE_HIGHLIGHT = "nexus:reader-pulse-highlight";

export interface ReaderPulseTarget {
  mediaId: string;
  highlightId?: string;
  evidenceSpanId?: string;
  locator: RetrievalLocator;
  snippet: string | null;
  highlightBehavior: "pulse";
  focusBehavior: "scroll_into_view" | "preserve_position";
}

const readerPulseChannel = createWindowEventChannel<ReaderPulseTarget>({
  eventName: READER_PULSE_HIGHLIGHT,
  cancelable: false,
});

// Reader-source activations can precede the destination pane mount. Keep the
// latest target per media identity until useReaderTarget acknowledges it; the
// window event remains the immediate path for an already-mounted reader.
const pendingReaderPulseByMediaId = new Map<string, ReaderPulseTarget>();

export function dispatchReaderPulse(target: ReaderPulseTarget): void {
  if (target.focusBehavior === "scroll_into_view") pendingReaderPulseByMediaId.set(target.mediaId, target);
  readerPulseChannel.dispatch(target);
}

export function consumePendingReaderPulse(
  mediaId: string,
  expected?: ReaderPulseTarget,
): ReaderPulseTarget | null {
  const pending = pendingReaderPulseByMediaId.get(mediaId);
  if (!pending || (expected !== undefined && pending !== expected)) {
    return null;
  }
  pendingReaderPulseByMediaId.delete(mediaId);
  return pending;
}

export function useReaderPulseHighlight(
  handler: (target: ReaderPulseTarget) => void,
): void {
  readerPulseChannel.useSubscribe(handler);
}

export const NOTE_PULSE_HIGHLIGHT = "nexus:note-pulse-highlight";

/** Pulse target for a note body range. */
export interface NotePulseTarget {
  blockId: string;
  startOffset: number;
  endOffset: number;
  snippet: string | null;
  highlightBehavior: "pulse";
  focusBehavior: "scroll_into_view";
}

const notePulseChannel = createWindowEventChannel<NotePulseTarget>({
  eventName: NOTE_PULSE_HIGHLIGHT,
  cancelable: false,
});

export function dispatchNotePulse(target: NotePulseTarget): void {
  notePulseChannel.dispatch(target);
}

export function useNotePulseHighlight(
  handler: (target: NotePulseTarget) => void,
): void {
  notePulseChannel.useSubscribe(handler);
}
