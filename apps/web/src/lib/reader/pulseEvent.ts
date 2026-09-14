"use client";

import type { ResourceCache, ReaderSourceInputLease } from "@/lib/api/resourceCache";
import { isRetrievalLocator, type RetrievalLocator } from "@/lib/api/sse/locators";
import { isRecord } from "@/lib/validation";
import { createWindowEventChannel } from "@/lib/windowEventChannel";

export const READER_PULSE_HIGHLIGHT = "nexus:reader-pulse-highlight";

export interface ReaderPulseInput {
  mediaId: string;
  highlightId?: string;
  evidenceSpanId?: string;
  locator: RetrievalLocator;
  snippet: string | null;
  highlightBehavior: "pulse";
  focusBehavior: "scroll_into_view";
}

export interface ReaderPulseTarget extends ReaderPulseInput {
  paneId: string;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isReaderPulseTarget(value: unknown): value is ReaderPulseTarget {
  if (!isRecord(value)) return false;
  return (
    typeof value.paneId === "string" && value.paneId.length > 0 &&
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

// Reader-source activations can precede the destination pane mount. Keep the
// latest target per pane/media identity until the addressed reader acknowledges it; the
// window event remains the immediate path for an already-mounted reader.
interface PendingReaderPulse {
  readonly target: ReaderPulseTarget;
  readonly input: ReaderSourceInputLease;
  retire: (() => void | Promise<void>) | null;
}
const pendingReaderPulseByPane = new Map<string, PendingReaderPulse>();

function retireDelivery({ input, retire }: PendingReaderPulse): void {
  const settled = retire?.();
  if (settled === undefined) input.release();
  else void settled.finally(() => input.release());
}

export function dispatchReaderPulse(target: ReaderPulseTarget, input: ReaderSourceInputLease): void {
  const key = `${target.paneId}:${target.mediaId}`;
  const previous = pendingReaderPulseByPane.get(key);
  pendingReaderPulseByPane.delete(key);
  if (previous !== undefined) retireDelivery(previous);
  pendingReaderPulseByPane.set(key, { target, input, retire: null });
  readerPulseChannel.dispatch(target);
}

export function readPendingReaderPulse(paneId: string, mediaId: string): ReaderPulseTarget | null {
  return pendingReaderPulseByPane.get(`${paneId}:${mediaId}`)?.target ?? null;
}

/** Actual workspace navigation/close withdraws undelivered source payloads. */
export function clearPendingReaderPulse(paneId: string): void {
  for (const [key, entry] of pendingReaderPulseByPane) {
    if (entry.target.paneId !== paneId) continue;
    pendingReaderPulseByPane.delete(key);
    retireDelivery(entry);
  }
}

/** Account withdrawal uses the same exact pending-delivery owner as pane closure. */
export function clearPendingReaderPulsesForCache(cache: ResourceCache): void {
  for (const [key, entry] of pendingReaderPulseByPane) {
    if (entry.input.cache !== cache) continue;
    pendingReaderPulseByPane.delete(key);
    retireDelivery(entry);
  }
}

export function retryPendingReaderPulse(paneId: string, mediaId: string): void {
  const pending = pendingReaderPulseByPane.get(`${paneId}:${mediaId}`);
  if (pending !== undefined) readerPulseChannel.dispatch(pending.target);
}

/** A new command withdraws the previous admission before reusing this input. */
export function withdrawPendingReaderPulseAdmission(target: ReaderPulseTarget): void | Promise<void> {
  const pending = pendingReaderPulseByPane.get(`${target.paneId}:${target.mediaId}`);
  if (pending?.target !== target) return;
  const retire = pending.retire;
  pending.retire = null;
  return retire?.();
}

/** The one admitted command remains charged while this delivery waits for retry. */
export function retainPendingReaderPulse(target: ReaderPulseTarget, retire: () => void | Promise<void>): boolean {
  const pending = pendingReaderPulseByPane.get(`${target.paneId}:${target.mediaId}`);
  if (pending?.target !== target) return false;
  if (pending.retire !== null) throw new Error("Reader source delivery already has an admitted command");
  pending.retire = retire;
  return true;
}

export function consumePendingReaderPulse(
  paneId: string,
  mediaId: string,
  expected?: ReaderPulseTarget,
): ReaderPulseTarget | null {
  const key = `${paneId}:${mediaId}`;
  const pending = pendingReaderPulseByPane.get(key);
  if (!pending || (expected !== undefined && pending.target !== expected)) {
    return null;
  }
  pendingReaderPulseByPane.delete(key);
  retireDelivery(pending);
  return pending.target;
}

/** Mounted transcript content retains its own source until its immediate pulse returns. */
export function dispatchMountedReaderPulse(target: ReaderPulseTarget): void {
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
