"use client";

import { useEffect } from "react";
import { isRetrievalLocator, type RetrievalLocator } from "@/lib/api/sse/locators";
import { isRecord } from "@/lib/validation";

/**
 * A single window-`CustomEvent` channel: the dispatch side, the subscribe hook,
 * and the event name, all routed through one type guard so the dispatch and the
 * listener can never disagree about the payload shape. Reader and note pulses
 * are two instances of this primitive.
 */
export interface PulseChannel<T> {
  eventName: string;
  dispatch: (target: T) => void;
  useSubscribe: (handler: (target: T) => void) => void;
}

export function createPulseChannel<T>(
  eventName: string,
  isTarget: (value: unknown) => value is T,
): PulseChannel<T> {
  function dispatch(target: T): void {
    window.dispatchEvent(new CustomEvent<T>(eventName, { detail: target }));
  }

  function useSubscribe(handler: (target: T) => void): void {
    useEffect(() => {
      function listener(event: Event) {
        if (!(event instanceof CustomEvent) || !isTarget(event.detail)) {
          return;
        }
        handler(event.detail);
      }
      window.addEventListener(eventName, listener);
      return () => window.removeEventListener(eventName, listener);
    }, [handler]);
  }

  return { eventName, dispatch, useSubscribe };
}

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

const readerPulseChannel = createPulseChannel(
  READER_PULSE_HIGHLIGHT,
  isReaderPulseTarget,
);

export const dispatchReaderPulse = readerPulseChannel.dispatch;
export const useReaderPulseHighlight = readerPulseChannel.useSubscribe;

export const NOTE_PULSE_HIGHLIGHT = "nexus:note-pulse-highlight";

/**
 * Pulse target for a notes page: scroll the page editor to `blockId` and pulse
 * the `[startOffset, endOffset)` character range. The notes analog of
 * {@link ReaderPulseTarget}.
 */
export interface NotePulseTarget {
  pageId: string;
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
    typeof value.pageId === "string" &&
    typeof value.blockId === "string" &&
    typeof value.startOffset === "number" &&
    typeof value.endOffset === "number" &&
    (typeof value.snippet === "string" || value.snippet === null) &&
    value.highlightBehavior === "pulse" &&
    value.focusBehavior === "scroll_into_view"
  );
}

const notePulseChannel = createPulseChannel(
  NOTE_PULSE_HIGHLIGHT,
  isNotePulseTarget,
);

export const dispatchNotePulse = notePulseChannel.dispatch;
export const useNotePulseHighlight = notePulseChannel.useSubscribe;
