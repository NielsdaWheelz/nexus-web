"use client";

import { useEffect } from "react";
import { isRetrievalLocator, type RetrievalLocator } from "@/lib/api/sse/locators";
import { isRecord } from "@/lib/validation";

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

export function dispatchReaderPulse(target: ReaderPulseTarget): void {
  window.dispatchEvent(
    new CustomEvent<ReaderPulseTarget>(READER_PULSE_HIGHLIGHT, {
      detail: target,
    }),
  );
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

export function useReaderPulseHighlight(
  handler: (target: ReaderPulseTarget) => void,
): void {
  useEffect(() => {
    function listener(event: Event) {
      if (!(event instanceof CustomEvent) || !isReaderPulseTarget(event.detail)) {
        return;
      }
      handler(event.detail);
    }
    window.addEventListener(READER_PULSE_HIGHLIGHT, listener);
    return () => window.removeEventListener(READER_PULSE_HIGHLIGHT, listener);
  }, [handler]);
}
