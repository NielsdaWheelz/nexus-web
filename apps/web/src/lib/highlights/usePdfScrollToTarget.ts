"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";

const SCROLL_RETRY_ATTEMPTS = 8;

interface PdfScrollTarget {
  key: string;
  pageNumber: number;
  quads: PdfHighlightQuad[];
  isCurrent?: () => boolean;
}

export function usePdfScrollToTarget({
  target, ready, runRef, pageNumberRef, goToPage, waitForPagePaint, scrollToProjectedHighlight, onSettle,
}: {
  target: PdfScrollTarget | null;
  ready: boolean;
  runRef: MutableRefObject<number>;
  pageNumberRef: MutableRefObject<number>;
  goToPage: (pageNumber: number) => Promise<void> | void;
  waitForPagePaint: (pageNumber: number, signal: AbortSignal) => Promise<boolean>;
  scrollToProjectedHighlight: (pageNumber: number, quads: PdfHighlightQuad[], isCurrent: () => boolean) => Promise<boolean>;
  onSettle?: (positioned: boolean) => void;
}): void {
  const processedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!target || target.quads.length === 0) {
      processedKeyRef.current = null;
      return;
    }
    if (!ready || processedKeyRef.current === target.key) return;
    const abort = new AbortController();
    let frame = 0;
    const startRun = runRef.current;
    const isCurrent = () => !abort.signal.aborted && startRun === runRef.current && (target.isCurrent?.() ?? true);
    const settle = (positioned: boolean) => {
      if (!isCurrent()) return;
      processedKeyRef.current = target.key;
      onSettle?.(positioned);
    };
    const tryScroll = async (remaining: number): Promise<void> => {
      if (!isCurrent()) return;
      try {
        const positioned = await scrollToProjectedHighlight(target.pageNumber, target.quads, isCurrent);
        if (!isCurrent()) return;
        if (positioned || remaining === 0) settle(positioned);
        else frame = window.requestAnimationFrame(() => { void tryScroll(remaining - 1); });
      } catch {
        settle(false);
      }
    };
    void (async () => {
      try {
        if (!isCurrent()) return;
        if (target.pageNumber !== pageNumberRef.current) await goToPage(target.pageNumber);
        if (!await waitForPagePaint(target.pageNumber, abort.signal)) {
          settle(false);
          return;
        }
        await tryScroll(SCROLL_RETRY_ATTEMPTS);
      } catch {
        settle(false);
      }
    })();
    return () => {
      abort.abort();
      window.cancelAnimationFrame(frame);
    };
  }, [goToPage, onSettle, pageNumberRef, ready, runRef, scrollToProjectedHighlight, target, waitForPagePaint]);
}
