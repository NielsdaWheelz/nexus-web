"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { parseMediaRef } from "@/lib/consumption/activityContract";
import { documentWordBoundaryOrdinal } from "@/lib/consumption/canonicalWordPosition";
import {
  projectReaderDocumentPoint,
  type ReaderDocumentProjection,
  type ReaderSemanticViewport,
} from "@/lib/reader/readerDocumentPosition";

interface ReaderActivityText {
  fragmentId: string;
  canonicalText: string;
  documentWordStart?: number;
  startsInWord: boolean;
  unitStartOffset: number;
}

interface ReaderActivityViewport {
  hydrated: boolean;
  kind: "desktop" | "mobile";
}

interface UseReaderActivityAdapterInput {
  mediaId: string;
  observerKey: string;
  canRead: boolean;
  paneActive: boolean;
  viewport: ReaderActivityViewport;
  activityRootRef: RefObject<HTMLDivElement | null>;
  activeContent: ReaderActivityText | null;
  semanticViewport: ReaderSemanticViewport | null;
  documentProjection: ReaderDocumentProjection | null;
  onGenuineReaderInput: () => void;
  previewLease: {
    isActive(): boolean;
    subscribe(listener: () => void): () => void;
  };
}

interface ReaderActivityAdapter {
  noteGenuineInput: () => void;
}

const READING_IDLE_AFTER_MS = 300_000;

function isReaderScrollKey(event: KeyboardEvent): boolean {
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
  paneActive,
  viewport,
  activityRootRef,
  activeContent,
  semanticViewport,
  documentProjection,
  onGenuineReaderInput,
  previewLease,
}: UseReaderActivityAdapterInput): ReaderActivityAdapter {
  const lastGenuineInputMonoRef = useRef<number | undefined>(undefined);
  const semanticViewportRef = useRef(semanticViewport);
  semanticViewportRef.current = semanticViewport;
  const documentProjectionRef = useRef(documentProjection);
  documentProjectionRef.current = documentProjection;
  const genuineRestoreSourceKeyRef = useRef<string | undefined>(undefined);
  const documentKind = documentProjection?.kind ?? null;
  const activeFragmentId = activeContent?.fragmentId;
  const canonicalText = activeContent?.canonicalText ?? "";
  const documentWordStart = activeContent?.documentWordStart;
  const startsInWord = activeContent?.startsInWord ?? false;
  const unitStartOffset = activeContent?.unitStartOffset ?? 0;
  const updateRef = useRef<() => void>(() => undefined);

  const noteGenuineInput = useCallback(() => {
    const currentViewport = semanticViewportRef.current;
    genuineRestoreSourceKeyRef.current =
      currentViewport?.intent === "Restore"
        ? currentViewport.sourceKey
        : undefined;
    lastGenuineInputMonoRef.current = performance.now();
    updateRef.current();
  }, []);

  useEffect(() => {
    if (
      !viewport.hydrated ||
      !canRead ||
      documentKind === null ||
      (documentKind === "Text" && activeFragmentId === undefined)
    ) {
      return;
    }
    const root = activityRootRef.current;
    if (!root) return;

    const recorder = activityRecorder();
    const update = () => {
      const now = performance.now();
      const lastGenuineInputMono = lastGenuineInputMonoRef.current;
      const currentSemanticViewport = semanticViewportRef.current;
      const currentDocumentProjection = documentProjectionRef.current;
      const visibleStart = currentSemanticViewport?.visibleStart;
      const progress =
        currentSemanticViewport && currentDocumentProjection
          ? projectReaderDocumentPoint(
              currentDocumentProjection,
              currentSemanticViewport.visibleStart,
            )
          : undefined;
      const wordPosition =
        visibleStart?.kind !== "Text" ||
        visibleStart.fragmentId !== activeFragmentId ||
        documentWordStart === undefined
          ? undefined
          : documentWordBoundaryOrdinal({
              canonicalText,
              documentWordStart,
              offset: visibleStart.offset - unitStartOffset,
              startsInWord,
            });
      recorder.observe(observerKey, {
        mediaRef: parseMediaRef(`media:${mediaId}`),
        modality: "Reading",
        deviceClass: viewport.kind === "mobile" ? "Mobile" : "Desktop",
        eligible:
          paneActive &&
          !previewLease.isActive() &&
          (currentSemanticViewport?.intent === "Reader" ||
            (currentSemanticViewport?.intent === "Restore" &&
              genuineRestoreSourceKeyRef.current ===
                currentSemanticViewport.sourceKey)) &&
          document.visibilityState === "visible" &&
          document.hasFocus() &&
          lastGenuineInputMono !== undefined &&
          now < lastGenuineInputMono + READING_IDLE_AFTER_MS,
        idleUntilMono:
          lastGenuineInputMono === undefined
            ? undefined
            : lastGenuineInputMono + READING_IDLE_AFTER_MS,
        measurement: {
          progress,
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
      if (event instanceof KeyboardEvent && !isReaderScrollKey(event)) return;
      onGenuineReaderInput();
      noteGenuineInput();
    };
    updateRef.current = update;
    const unsubscribePreviewLease = previewLease.subscribe(update);
    root.addEventListener("pointerdown", noteInput, { passive: true });
    root.addEventListener("touchstart", noteInput, { passive: true });
    root.addEventListener("wheel", noteInput, { passive: true });
    root.addEventListener("keydown", noteInput);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    update();
    return () => {
      root.removeEventListener("pointerdown", noteInput);
      root.removeEventListener("touchstart", noteInput);
      root.removeEventListener("wheel", noteInput);
      root.removeEventListener("keydown", noteInput);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      updateRef.current = () => undefined;
      unsubscribePreviewLease();
      unregister();
    };
  }, [
    activeFragmentId,
    canonicalText,
    documentWordStart,
    startsInWord,
    unitStartOffset,
    canRead,
    documentKind,
    mediaId,
    observerKey,
    onGenuineReaderInput,
    noteGenuineInput,
    paneActive,
    activityRootRef,
    previewLease,
    viewport.hydrated,
    viewport.kind,
  ]);

  useEffect(() => {
    if (
      semanticViewport?.intent !== "Restore" ||
      semanticViewport.sourceKey !== genuineRestoreSourceKeyRef.current
    ) {
      genuineRestoreSourceKeyRef.current = undefined;
    }
    updateRef.current();
  }, [documentProjection, semanticViewport]);

  return { noteGenuineInput };
}
