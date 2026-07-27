"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { parseMediaRef } from "@/lib/consumption/activityContract";
import { documentWordBoundaryOrdinal } from "@/lib/consumption/canonicalWordPosition";

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
  activeContent: ReaderActivityText | null;
  pdfControls: ReaderActivityPdfControls | null;
}

interface ReaderActivityTextMeasurement {
  anchorOffset: number | null;
  totalProgression: number | null;
}

interface ReaderActivityAdapter {
  noteGenuineInput: () => void;
  publishTextMeasurement: (
    measurement: ReaderActivityTextMeasurement,
  ) => void;
}

const READING_IDLE_AFTER_MS = 300_000;

function isPdfScrollKey(event: KeyboardEvent): boolean {
  return (
    event.key === "ArrowDown" ||
    event.key === "ArrowUp" ||
    event.key === "PageDown" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    event.key === "End" ||
    event.key === " " ||
    event.key === "Spacebar"
  );
}

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
  activeContent,
  pdfControls,
}: UseReaderActivityAdapterInput): ReaderActivityAdapter {
  const lastGenuineInputMonoRef = useRef<number | undefined>(undefined);
  const textMeasurementRef = useRef<ReaderActivityTextMeasurement>({
    anchorOffset: null,
    totalProgression: null,
  });
  const updateRef = useRef<() => void>(() => undefined);

  const noteGenuineInput = useCallback(() => {
    lastGenuineInputMonoRef.current = performance.now();
    updateRef.current();
  }, []);

  const publishTextMeasurement = useCallback(
    (measurement: ReaderActivityTextMeasurement) => {
      textMeasurementRef.current = measurement;
      updateRef.current();
    },
    [],
  );

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
      const textMeasurement = textMeasurementRef.current;
      const wordPosition =
        textMeasurement.anchorOffset === null ||
        activeContent?.documentWordStart === undefined
          ? undefined
          : documentWordBoundaryOrdinal({
              canonicalText: activeContent.canonicalText,
              documentWordStart: activeContent.documentWordStart,
              offset: textMeasurement.anchorOffset,
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
              : (textMeasurement.totalProgression ?? undefined),
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
      if (event instanceof KeyboardEvent && !isPdfScrollKey(event)) return;
      lastGenuineInputMonoRef.current = performance.now();
      update();
    };
    updateRef.current = update;
    root.addEventListener("pointerdown", noteInput, { passive: true });
    if (isPdf) {
      root.addEventListener("touchstart", noteInput, { passive: true });
      root.addEventListener("wheel", noteInput, { passive: true });
      root.addEventListener("keydown", noteInput);
      root.addEventListener("scroll", update, { passive: true });
    }
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    update();
    return () => {
      root.removeEventListener("pointerdown", noteInput);
      if (isPdf) {
        root.removeEventListener("touchstart", noteInput);
        root.removeEventListener("wheel", noteInput);
        root.removeEventListener("keydown", noteInput);
        root.removeEventListener("scroll", update);
      }
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      updateRef.current = () => undefined;
      unregister();
    };
  }, [
    activeContent,
    canRead,
    isPdf,
    mediaId,
    observerKey,
    paneActive,
    pdfContentRef,
    pdfControls,
    readerRootRef,
    viewport.hydrated,
    viewport.kind,
  ]);

  return { noteGenuineInput, publishTextMeasurement };
}
