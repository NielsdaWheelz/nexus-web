"use client";

import { useEffect } from "react";

export const READER_PULSE_HIGHLIGHT = "nexus:reader-pulse-highlight";

export interface ReaderPulseTarget {
  mediaId: string;
  locator: unknown;
  snippet: string | null;
}

export function dispatchReaderPulse(target: ReaderPulseTarget): void {
  window.dispatchEvent(
    new CustomEvent<ReaderPulseTarget>(READER_PULSE_HIGHLIGHT, { detail: target }),
  );
}

export function useReaderPulseHighlight(handler: (target: ReaderPulseTarget) => void): void {
  useEffect(() => {
    function listener(event: Event) {
      handler((event as CustomEvent<ReaderPulseTarget>).detail);
    }
    window.addEventListener(READER_PULSE_HIGHLIGHT, listener);
    return () => window.removeEventListener(READER_PULSE_HIGHLIGHT, listener);
  }, [handler]);
}
