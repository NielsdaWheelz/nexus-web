"use client";

import { useEffect, useRef, type RefObject } from "react";
import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { parseMediaRef } from "@/lib/consumption/activityContract";
import { documentWordBoundaryOrdinal } from "@/lib/consumption/canonicalWordPosition";
import type { CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import { findFirstVisibleCanonicalOffset, getPaneScrollContainer } from "./paneTextAnchor";

interface ReaderActivityText {
  canonicalText: string;
  documentWordStart?: number;
}

interface ReaderActivityPdfControls {
  pageNumber: number;
  numPages: number;
}

interface ReaderActivityViewport {
  hydrated: boolean;
  kind: "desktop" | "mobile";
}

interface UseReaderActivityAdapterInput {
  mediaId: string;
  observerKey: string;
  canRead: boolean;
  isPdf: boolean;
  paneActive: boolean;
  viewport: ReaderActivityViewport;
  readerRootRef: RefObject<HTMLDivElement | null>;
  pdfContentRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  cursorRef: RefObject<CanonicalCursorResult | null>;
  activeContent: ReaderActivityText | null;
  pdfControls: ReaderActivityPdfControls | null;
  totalProgression: number | null;
  isUserScrollKey: (event: KeyboardEvent) => boolean;
}

const READING_IDLE_AFTER_MS = 300_000;

/**
 * Publish one reader pane's eligibility to the tab-local activity recorder.
 * Trusted DOM input is the only operation that refreshes its idle deadline.
 */
export function useReaderActivityAdapter({
  mediaId,
  observerKey,
  canRead,
  isPdf,
  paneActive,
  viewport,
  readerRootRef,
  pdfContentRef,
  contentRef,
  cursorRef,
  activeContent,
  pdfControls,
  totalProgression,
  isUserScrollKey,
}: UseReaderActivityAdapterInput): void {
  const lastGenuineInputMonoRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!viewport.hydrated || !canRead || (!isPdf && !activeContent)) {
      return;
    }
    const root = isPdf ? pdfContentRef.current : readerRootRef.current;
    if (!root) return;

    const recorder = activityRecorder();
    const update = () => {
      const now = performance.now();
      const lastGenuineInputMono = lastGenuineInputMonoRef.current;
      const container = isPdf ? null : getPaneScrollContainer(contentRef.current);
      const cursor = cursorRef.current;
      const anchorOffset =
        !isPdf && container && cursor
          ? findFirstVisibleCanonicalOffset(container, cursor)
          : null;
      const wordPosition =
        anchorOffset === null || activeContent?.documentWordStart === undefined
          ? undefined
          : documentWordBoundaryOrdinal({
              canonicalText: activeContent.canonicalText,
              documentWordStart: activeContent.documentWordStart,
              offset: anchorOffset,
            });
      recorder.observe(observerKey, {
        mediaRef: parseMediaRef(`media:${mediaId}`),
        modality: "Reading",
        deviceClass: viewport.kind === "mobile" ? "Mobile" : "Desktop",
        eligible:
          paneActive &&
          document.visibilityState === "visible" &&
          document.hasFocus() &&
          lastGenuineInputMono !== undefined &&
          now < lastGenuineInputMono + READING_IDLE_AFTER_MS,
        idleUntilMono:
          lastGenuineInputMono === undefined
            ? undefined
            : lastGenuineInputMono + READING_IDLE_AFTER_MS,
        measurement: {
          progress:
            isPdf
              ? pdfControls && pdfControls.numPages > 0
                ? pdfControls.pageNumber / pdfControls.numPages
                : undefined
              : (totalProgression ?? undefined),
          // PDFs have no canonical text ordinal. `undefined` becomes Absent at
          // the recorder's strict wire boundary.
          wordPosition,
        },
      });
    };
    const unregister = recorder.registerObserver(observerKey, {
      mediaRef: parseMediaRef(`media:${mediaId}`),
      modality: "Reading",
      deviceClass: viewport.kind === "mobile" ? "Mobile" : "Desktop",
      eligible: false,
    });
    const noteInput = (event: Event) => {
      if (!event.isTrusted) return;
      if (event instanceof KeyboardEvent && !isUserScrollKey(event)) return;
      lastGenuineInputMonoRef.current = performance.now();
      update();
    };
    const refreshMeasurement = () => update();
    root.addEventListener("pointerdown", noteInput, { passive: true });
    root.addEventListener("touchstart", noteInput, { passive: true });
    root.addEventListener("wheel", noteInput, { passive: true });
    root.addEventListener("keydown", noteInput);
    root.addEventListener("scroll", refreshMeasurement, { passive: true });
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    update();
    return () => {
      root.removeEventListener("pointerdown", noteInput);
      root.removeEventListener("touchstart", noteInput);
      root.removeEventListener("wheel", noteInput);
      root.removeEventListener("keydown", noteInput);
      root.removeEventListener("scroll", refreshMeasurement);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      unregister();
    };
  }, [
    activeContent,
    canRead,
    contentRef,
    cursorRef,
    isPdf,
    isUserScrollKey,
    mediaId,
    observerKey,
    paneActive,
    pdfContentRef,
    pdfControls,
    readerRootRef,
    totalProgression,
    viewport.hydrated,
    viewport.kind,
  ]);
}
