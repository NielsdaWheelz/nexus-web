"use client";

import { isRetrievalLocator, type RetrievalLocator } from "@/lib/api/sse/locators";
import { isRecord } from "@/lib/validation";
import { createWindowEventChannel } from "@/lib/windowEventChannel";

export const READER_PULSE_HIGHLIGHT = "nexus:reader-pulse-highlight";

export interface ReaderPulseTarget {
  mediaId: string;
  highlightId?: string;
  evidenceSpanId?: string;
  locator: RetrievalLocator;
  snippet: string | null;
  highlightBehavior: "pulse";
  focusBehavior: "scroll_into_view";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isReaderPulseTarget(value: unknown): value is ReaderPulseTarget {
  if (!isRecord(value)) return false;
  return (
    typeof value.mediaId === "string" &&
    isOptionalString(value.highlightId) &&
    isOptionalString(value.evidenceSpanId) &&
    isRetrievalLocator(value.locator) &&
    (typeof value.snippet === "string" || value.snippet === null) &&
    value.highlightBehavior === "pulse" &&
    value.focusBehavior === "scroll_into_view"
  );
}

const readerPulseChannel = createWindowEventChannel({
  eventName: READER_PULSE_HIGHLIGHT,
  isTarget: isReaderPulseTarget,
  cancelable: false,
});

export function dispatchReaderPulse(target: ReaderPulseTarget): void {
  readerPulseChannel.dispatch(target);
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

export function isNotePulseTarget(value: unknown): value is NotePulseTarget {
  if (!isRecord(value)) return false;
  return (
    typeof value.blockId === "string" &&
    typeof value.startOffset === "number" &&
    typeof value.endOffset === "number" &&
    (typeof value.snippet === "string" || value.snippet === null) &&
    value.highlightBehavior === "pulse" &&
    value.focusBehavior === "scroll_into_view"
  );
}

const notePulseChannel = createWindowEventChannel({
  eventName: NOTE_PULSE_HIGHLIGHT,
  isTarget: isNotePulseTarget,
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
