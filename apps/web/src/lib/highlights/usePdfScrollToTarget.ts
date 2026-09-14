"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { PdfEventBusLike } from "@/components/pdfReaderRuntime";

interface PdfScrollTarget {
  /** Idempotency key — repeated effects with the same key are ignored. */
  key: string;
  pageNumber: number;
  quads: readonly PdfHighlightQuad[] | null;
}

interface UsePdfScrollToTargetOptions {
  target: PdfScrollTarget | null;
  /** True once the viewer has rendered its initial page and accepts navigation. */
  ready: boolean;
  failed: boolean;
  eventBusRef: MutableRefObject<PdfEventBusLike | null>;
  runRef: MutableRefObject<number>;
  pageNumberRef: MutableRefObject<number>;
  goToPage: (pageNumber: number) => Promise<void> | void;
  scrollToTarget: (
    pageNumber: number,
    quads: readonly PdfHighlightQuad[] | null,
  ) => boolean;
  /** Called once per non-cancelled target after the scroll chain settles. */
  onSettle?: (positioned: boolean) => void;
}

/**
 * Position an already rendered page, or wait for its actual render event.
 * The target owns its listener until positioning, failure, or retirement.
 */
export function usePdfScrollToTarget({
  target,
  ready,
  failed,
  eventBusRef,
  runRef,
  pageNumberRef,
  goToPage,
  scrollToTarget,
  onSettle,
}: UsePdfScrollToTargetOptions): void {
  const processedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!target || target.quads?.length === 0) {
      processedKeyRef.current = null;
      return;
    }
    if (failed) {
      onSettle?.(false);
      return;
    }
    if (!ready) {
      return;
    }
    if (processedKeyRef.current === target.key) {
      return;
    }
    processedKeyRef.current = target.key;

    const key = target.key;
    const pageNumber = target.pageNumber;
    let pending: {
      quads: readonly PdfHighlightQuad[] | null;
      onSettle: typeof onSettle;
    } | null = {
      quads: target.quads,
      onSettle,
    };
    let completed = false;
    let frame: number | null = null;
    const startRun = runRef.current;
    const eventBus = eventBusRef.current;

    const settle = (positioned: boolean) => {
      const callback = pending?.onSettle;
      pending = null;
      completed = true;
      eventBus?.off("pagerendered", rendered);
      callback?.(positioned);
    };

    const tryScroll = () => {
      frame = null;
      if (pending === null) return;
      if (startRun !== runRef.current) {
        settle(false);
        return;
      }
      const positioned = scrollToTarget(pageNumber, pending.quads);
      if (positioned) settle(true);
    };

    const rendered = (raw: unknown) => {
      const event = raw as { pageNumber?: number; error?: unknown };
      if (event.pageNumber !== pageNumber || pending === null) return;
      if (event.error != null || startRun !== runRef.current) { settle(false); return; }
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(tryScroll);
    };
    eventBus?.on("pagerendered", rendered);

    void (async () => {
      try {
        if (pageNumber !== pageNumberRef.current) await goToPage(pageNumber);
        tryScroll();
      } catch {
        settle(false);
      }
    })();

    return () => {
      // Awaiting goToPage and dispatched RAF callbacks retain only this nullable
      // cell, never borrowed quads or the callback closing over their target.
      pending = null;
      eventBus?.off("pagerendered", rendered);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (!completed && processedKeyRef.current === key)
        processedKeyRef.current = null;
    };
  }, [
    goToPage,
    eventBusRef,
    failed,
    onSettle,
    pageNumberRef,
    ready,
    runRef,
    scrollToTarget,
    target,
  ]);
}
