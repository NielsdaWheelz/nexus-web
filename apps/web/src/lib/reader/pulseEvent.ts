"use client";

import { useEffect } from "react";
import type { RetrievalLocator } from "@/lib/api/sse/locators";

export const READER_PULSE_HIGHLIGHT = "nexus:reader-pulse-highlight";

export interface ReaderPulseTarget {
  mediaId: string;
  highlightId?: string;
  locator: RetrievalLocator;
  snippet: string | null;
  sourceVersion: string;
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

export function useReaderPulseHighlight(
  handler: (target: ReaderPulseTarget) => void,
): void {
  useEffect(() => {
    function listener(event: Event) {
      handler((event as CustomEvent<ReaderPulseTarget>).detail);
    }
    window.addEventListener(READER_PULSE_HIGHLIGHT, listener);
    return () => window.removeEventListener(READER_PULSE_HIGHLIGHT, listener);
  }, [handler]);
}
