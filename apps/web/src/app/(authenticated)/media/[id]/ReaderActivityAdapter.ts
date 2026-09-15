"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { isInteractiveTarget } from "@/lib/ui/interactiveTarget";
import { readerScrollKeyDirection } from "@/lib/reader/readerScrollInput";
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
  const genuineRestoreViewportRef = useRef<ReaderSemanticViewport | null>(null);
  const documentKind = documentProjection?.kind ?? null;
  const updateRef = useRef<() => void>(() => undefined);

  const noteGenuineInput = useCallback(() => {
    const currentViewport = semanticViewportRef.current;
    genuineRestoreViewportRef.current =
      currentViewport?.intent === "Restore"
        ? currentViewport
        : null;
    lastGenuineInputMonoRef.current = performance.now();
    updateRef.current();
  }, []);

  useEffect(() => {
    if (
      !viewport.hydrated ||
      !canRead ||
      documentKind === null ||
      (documentKind === "Text" && !activeContent)
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
        visibleStart.fragmentId !== activeContent?.fragmentId ||
        activeContent?.documentWordStart === undefined
          ? undefined
          : documentWordBoundaryOrdinal({
              canonicalText: activeContent.canonicalText,
              documentWordStart: activeContent.documentWordStart,
              offset: visibleStart.offset,
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
              genuineRestoreViewportRef.current === currentSemanticViewport)) &&
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
    const noteInput = (event: KeyboardEvent | PointerEvent | TouchEvent | WheelEvent) => {
      if (!event.isTrusted) return;
      if (event instanceof WheelEvent && event.ctrlKey) return;
      if ("touches" in event && event.touches.length !== 1) return;
      if (event.type === "pointerdown" && event instanceof PointerEvent && event.pointerType === "touch") return;
      if (event.type === "click" && (!(event instanceof PointerEvent) || event.pointerType !== "touch")) return;
      if (
        (event.type === "pointerdown" || event.type === "click") &&
        isInteractiveTarget(event.target, root)
      ) return;
      if (event instanceof KeyboardEvent && readerScrollKeyDirection(event) === null) return;
      onGenuineReaderInput();
      noteGenuineInput();
    };
    updateRef.current = update;
    const unsubscribePreviewLease = previewLease.subscribe(update);
    root.addEventListener("pointerdown", noteInput, { passive: true });
    root.addEventListener("click", noteInput, { passive: true });
    root.addEventListener("touchmove", noteInput, { passive: true });
    root.addEventListener("wheel", noteInput, { passive: true });
    root.addEventListener("keydown", noteInput);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    update();
    return () => {
      root.removeEventListener("pointerdown", noteInput);
      root.removeEventListener("click", noteInput);
      root.removeEventListener("touchmove", noteInput);
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
    activeContent,
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
      semanticViewport !== genuineRestoreViewportRef.current
    ) {
      genuineRestoreViewportRef.current = null;
    }
    updateRef.current();
  }, [documentProjection, semanticViewport]);

  return { noteGenuineInput };
}
