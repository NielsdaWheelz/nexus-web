"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { assertNever } from "@/lib/assertNever";

const RETAINED_SELECTION_STABILIZATION_DELAY_MS = 180;

export interface RetainedReaderSelectionSnapshot {
  readonly rect: DOMRect;
  readonly lineRects: readonly DOMRect[];
}

export type RetainedReaderSelectionPublication = "Immediate" | "Stabilized";

export interface RetainedReaderSelectionController<
  T extends RetainedReaderSelectionSnapshot,
> {
  readonly visible: T | null;
  readonly hasCaptured: boolean;
  readonly capture: (input: {
    readonly snapshot: T;
    readonly publication: RetainedReaderSelectionPublication;
  }) => void;
  readonly clear: () => void;
  readonly retainVisibleOrClear: () => void;
  readonly readCaptured: () => T | null;
  readonly refreshCaptured: (project: (captured: T) => T | null) => void;
}

function sameRect(left: DOMRect, right: DOMRect): boolean {
  const round = (value: number) => Math.round(value * 10);
  return (
    round(left.left) === round(right.left) &&
    round(left.top) === round(right.top) &&
    round(left.width) === round(right.width) &&
    round(left.height) === round(right.height)
  );
}

function sameGeometry(
  left: RetainedReaderSelectionSnapshot,
  right: RetainedReaderSelectionSnapshot,
): boolean {
  return (
    sameRect(left.rect, right.rect) &&
    left.lineRects.length === right.lineRects.length &&
    left.lineRects.every((rect, index) => {
      const other = right.lineRects[index];
      return other !== undefined && sameRect(rect, other);
    })
  );
}

export function useRetainedReaderSelection<
  T extends RetainedReaderSelectionSnapshot,
>(input: {
  readonly sameSemanticSelection: (left: T, right: T) => boolean;
}): RetainedReaderSelectionController<T> {
  const [{ visible, hasCaptured }, setPublication] = useState<{ visible: T | null; hasCaptured: boolean }>({ visible: null, hasCaptured: false });
  const capturedRef = useRef<T | null>(null);
  const visibleRef = useRef<T | null>(null);
  const stabilizationTimerRef = useRef<number | null>(null);
  const publicationGenerationRef = useRef(0);
  const sameSemanticSelectionRef = useRef(input.sameSemanticSelection);
  sameSemanticSelectionRef.current = input.sameSemanticSelection;

  const sameSnapshot = useCallback((left: T, right: T): boolean => {
    return (
      sameSemanticSelectionRef.current(left, right) && sameGeometry(left, right)
    );
  }, []);

  const cancelPendingPublication = useCallback(() => {
    publicationGenerationRef.current += 1;
    if (stabilizationTimerRef.current !== null) {
      window.clearTimeout(stabilizationTimerRef.current);
      stabilizationTimerRef.current = null;
    }
  }, []);

  const publish = useCallback((snapshot: T | null) => {
    visibleRef.current = snapshot;
    const captured = capturedRef.current !== null;
    setPublication((current) => current.visible === snapshot && current.hasCaptured === captured
      ? current : { visible: snapshot, hasCaptured: captured });
  }, []);

  const clear = useCallback(() => {
    capturedRef.current = null;
    cancelPendingPublication();
    publish(null);
  }, [cancelPendingPublication, publish]);

  const scheduleStabilizedPublication = useCallback(() => {
    cancelPendingPublication();
    const expectedGeneration = publicationGenerationRef.current;
    publish(null);
    stabilizationTimerRef.current = window.setTimeout(() => {
      stabilizationTimerRef.current = null;
      if (publicationGenerationRef.current !== expectedGeneration) {
        return;
      }
      publish(capturedRef.current);
    }, RETAINED_SELECTION_STABILIZATION_DELAY_MS);
  }, [cancelPendingPublication, publish]);

  const capture = useCallback(
    ({
      snapshot,
      publication,
    }: {
      readonly snapshot: T;
      readonly publication: RetainedReaderSelectionPublication;
    }) => {
      const previous = capturedRef.current;
      capturedRef.current = snapshot;

      switch (publication) {
        case "Immediate":
          cancelPendingPublication();
          publish(snapshot);
          return;
        case "Stabilized":
          if (
            previous !== null &&
            sameSnapshot(previous, snapshot) &&
            (visibleRef.current !== null ||
              stabilizationTimerRef.current !== null)
          ) {
            return;
          }
          scheduleStabilizedPublication();
          return;
        default:
          assertNever(publication);
      }
    },
    [
      cancelPendingPublication,
      publish,
      scheduleStabilizedPublication,
      sameSnapshot,
    ],
  );

  const retainVisibleOrClear = useCallback(() => {
    cancelPendingPublication();
    if (visibleRef.current !== null && capturedRef.current !== null) {
      return;
    }
    capturedRef.current = null;
    publish(null);
  }, [cancelPendingPublication, publish]);

  const readCaptured = useCallback(() => capturedRef.current, []);

  const refreshCaptured = useCallback(
    (project: (captured: T) => T | null) => {
      const captured = capturedRef.current;
      if (captured === null) {
        return;
      }
      const refreshed = project(captured);
      if (refreshed === null) {
        clear();
        return;
      }
      const hadPendingPublication = stabilizationTimerRef.current !== null;
      capturedRef.current = refreshed;

      if (visibleRef.current !== null) {
        if (!sameSnapshot(captured, refreshed)) {
          publish(refreshed);
        }
        return;
      }
      if (hadPendingPublication && !sameSnapshot(captured, refreshed)) {
        scheduleStabilizedPublication();
      }
    },
    [clear, publish, sameSnapshot, scheduleStabilizedPublication],
  );

  useEffect(() => cancelPendingPublication, [cancelPendingPublication]);

  return useMemo(
    () => ({
      visible,
      hasCaptured,
      capture,
      clear,
      retainVisibleOrClear,
      readCaptured,
      refreshCaptured,
    }),
    [
      capture,
      clear,
      readCaptured,
      refreshCaptured,
      retainVisibleOrClear,
      visible,
      hasCaptured,
    ],
  );
}

export function useRetainedReaderSelectionGeometry(input: {
  readonly enabled: boolean;
  readonly sourceKey: string | null;
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly contentRef: RefObject<HTMLElement | null>;
  readonly refresh: () => void;
}): void {
  const refreshRef = useRef(input.refresh);
  refreshRef.current = input.refresh;

  useEffect(() => {
    if (!input.enabled) {
      return;
    }

    let active = true;
    let refreshFrame: number | null = null;
    const scheduleRefresh = () => {
      if (!active || refreshFrame !== null) {
        return;
      }
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null;
        if (active) {
          refreshRef.current();
        }
      });
    };

    const viewport = input.viewportRef.current;
    const content = input.contentRef.current;
    const visualViewport = window.visualViewport;
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    if (viewport !== null) {
      resizeObserver.observe(viewport);
    }
    if (content !== null && content !== viewport) {
      resizeObserver.observe(content);
    }
    viewport?.addEventListener("scroll", scheduleRefresh, { passive: true });
    window.addEventListener("resize", scheduleRefresh, { passive: true });
    window.addEventListener("scroll", scheduleRefresh, {
      capture: true,
      passive: true,
    });
    visualViewport?.addEventListener?.("resize", scheduleRefresh);
    visualViewport?.addEventListener?.("scroll", scheduleRefresh);
    scheduleRefresh();

    return () => {
      active = false;
      resizeObserver.disconnect();
      if (refreshFrame !== null) {
        window.cancelAnimationFrame(refreshFrame);
      }
      viewport?.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("scroll", scheduleRefresh, true);
      visualViewport?.removeEventListener?.("resize", scheduleRefresh);
      visualViewport?.removeEventListener?.("scroll", scheduleRefresh);
    };
  }, [input.contentRef, input.enabled, input.sourceKey, input.viewportRef]);
}
