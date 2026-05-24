"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";

const SCROLL_RETRY_ATTEMPTS = 8;

interface PdfScrollTarget {
  /** Idempotency key — repeated effects with the same key are ignored. */
  key: string;
  pageNumber: number;
  quads: PdfHighlightQuad[];
}

interface UsePdfScrollToTargetOptions {
  target: PdfScrollTarget | null;
  runRef: MutableRefObject<number>;
  pageNumberRef: MutableRefObject<number>;
  goToPage: (pageNumber: number) => Promise<void> | void;
  scrollToProjectedHighlight: (
    pageNumber: number,
    quads: PdfHighlightQuad[],
  ) => boolean;
  /** Called once per non-cancelled target after the scroll chain settles. */
  onSettle?: () => void;
}

/**
 * Scroll to a PDF highlight target by paging if needed, then retrying the
 * projected scroll up to `SCROLL_RETRY_ATTEMPTS` frames until the layout
 * matches. Targets are deduped by `target.key`; cancellation respects both the
 * effect-local flag and the surrounding reader run via `runRef`.
 */
export function usePdfScrollToTarget({
  target,
  runRef,
  pageNumberRef,
  goToPage,
  scrollToProjectedHighlight,
  onSettle,
}: UsePdfScrollToTargetOptions): void {
  const processedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!target || target.quads.length === 0) {
      processedKeyRef.current = null;
      return;
    }
    if (processedKeyRef.current === target.key) {
      return;
    }
    processedKeyRef.current = target.key;

    let cancelled = false;
    const startRun = runRef.current;

    const settle = () => {
      if (!cancelled) {
        onSettle?.();
      }
    };

    const tryScrollWithRetries = (remainingAttempts: number) => {
      if (cancelled || startRun !== runRef.current) {
        return;
      }
      if (
        scrollToProjectedHighlight(target.pageNumber, target.quads) ||
        remainingAttempts <= 0
      ) {
        settle();
        return;
      }
      window.requestAnimationFrame(() => {
        tryScrollWithRetries(remainingAttempts - 1);
      });
    };

    void (async () => {
      try {
        if (target.pageNumber !== pageNumberRef.current) {
          await goToPage(target.pageNumber);
        }
        tryScrollWithRetries(SCROLL_RETRY_ATTEMPTS);
      } catch {
        settle();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    goToPage,
    onSettle,
    pageNumberRef,
    runRef,
    scrollToProjectedHighlight,
    target,
  ]);
}
