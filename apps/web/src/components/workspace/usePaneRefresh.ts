"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isAbortError } from "@/lib/errors";
import type {
  PaneRefreshProgress,
  PaneRefreshPublication,
  PaneRefreshResult,
} from "@/lib/panes/panePublications";

const PANE_REFRESH_ARM_DISTANCE_PX = 72;
const PANE_REFRESH_MAX_OFFSET_PX = 96;
const PANE_REFRESH_DRAG_RESISTANCE = 0.45;
const PANE_REFRESH_SETTLED_MS = 900;

type PaneRefreshState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Pulling"; readonly offsetPx: number }
  | { readonly kind: "Armed"; readonly offsetPx: number }
  | {
      readonly kind: "Refreshing";
      readonly progress: PaneRefreshProgress;
    }
  | { readonly kind: "Settled"; readonly result: PaneRefreshResult };

interface PaneRefreshTouch {
  readonly identifier: number;
  readonly startX: number;
  readonly startY: number;
  intent: "Pending" | "Downward";
}

interface PaneRefreshExecution {
  readonly routeKey: string;
  readonly sourceKey: string;
  readonly controller: AbortController;
}

// A resolving publication has no operation to fence, so it owns no source key.
function paneRefreshSourceKey(
  publication: PaneRefreshPublication | undefined,
): string | null {
  return publication?.kind === "Refreshable" ? publication.sourceKey : null;
}

function findTouch(
  touches: TouchList,
  identifier: number,
): Touch | undefined {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.identifier === identifier) return touch;
  }
  return undefined;
}

function paneRefreshFeedback(state: PaneRefreshState): string | null {
  switch (state.kind) {
    case "Idle":
      return null;
    case "Pulling":
      return "Pull to refresh";
    case "Armed":
      return "Release to refresh";
    case "Refreshing":
      return state.progress.kind === "Determinate"
        ? `Refreshing ${state.progress.finishedCount} of ${state.progress.requestedCount}`
        : "Refreshing";
    case "Settled":
      return state.result.announcement;
    default: {
      const exhaustive: never = state;
      throw new Error(
        `Unhandled pane refresh state: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * The pane's refresh engine: the Pane.Refresh command's execution, its mobile
 * pull-to-refresh gesture over the pane scrollport, and the indicator state both
 * publish. Every execution is fenced on the route key and the publication's
 * source key, so a pane that navigates mid-refresh drops the result.
 */
export function usePaneRefresh(input: {
  publication: PaneRefreshPublication | undefined;
  routeKey: string;
  /** Whether the pull gesture applies: an active mobile pane on a refreshable route. */
  pullEnabled: boolean;
  scrollportRef: RefObject<HTMLDivElement | null>;
}): {
  state: PaneRefreshState;
  start: () => void;
  feedback: string | null;
  offsetPx: number;
  announcement: string | null;
} {
  const { publication, routeKey, pullEnabled, scrollportRef } = input;
  const sourceKey = paneRefreshSourceKey(publication);
  const publicationRef = useRef(publication);
  publicationRef.current = publication;
  const routeKeyRef = useRef(routeKey);
  routeKeyRef.current = routeKey;
  const [state, setState] = useState<PaneRefreshState>({ kind: "Idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const executionRef = useRef<PaneRefreshExecution | null>(null);
  const touchRef = useRef<PaneRefreshTouch | null>(null);
  const settledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitState = useCallback((next: PaneRefreshState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const clearSettledTimer = useCallback(() => {
    if (settledTimerRef.current === null) return;
    clearTimeout(settledTimerRef.current);
    settledTimerRef.current = null;
  }, []);
  const start = useCallback(() => {
    const current = publicationRef.current;
    if (current?.kind !== "Refreshable" || executionRef.current) {
      return;
    }

    clearSettledTimer();
    setAnnouncement(null);
    const execution: PaneRefreshExecution = {
      routeKey: routeKeyRef.current,
      sourceKey: current.sourceKey,
      controller: new AbortController(),
    };
    executionRef.current = execution;
    commitState({
      kind: "Refreshing",
      progress: { kind: "Indeterminate" },
    });

    void (async () => {
      try {
        const result = await current.execute({
          signal: execution.controller.signal,
          reportProgress: (progress) => {
            if (
              executionRef.current !== execution ||
              execution.controller.signal.aborted ||
              routeKeyRef.current !== execution.routeKey ||
              paneRefreshSourceKey(publicationRef.current) !==
                execution.sourceKey
            ) {
              return;
            }
            commitState({ kind: "Refreshing", progress });
          },
        });
        if (
          executionRef.current !== execution ||
          execution.controller.signal.aborted ||
          routeKeyRef.current !== execution.routeKey ||
          paneRefreshSourceKey(publicationRef.current) !== execution.sourceKey
        ) {
          return;
        }
        executionRef.current = null;
        setAnnouncement(result.announcement);
        commitState({ kind: "Settled", result });
        settledTimerRef.current = setTimeout(() => {
          settledTimerRef.current = null;
          if (
            routeKeyRef.current === execution.routeKey &&
            paneRefreshSourceKey(publicationRef.current) ===
              execution.sourceKey
          ) {
            commitState({ kind: "Idle" });
          }
        }, PANE_REFRESH_SETTLED_MS);
      } catch (error: unknown) {
        if (executionRef.current !== execution) return;
        executionRef.current = null;
        commitState({ kind: "Idle" });
        if (execution.controller.signal.aborted || isAbortError(error)) return;
        setAsyncDefect({ error });
      }
    })();
  }, [clearSettledTimer, commitState]);
  useEffect(() => {
    touchRef.current = null;
    clearSettledTimer();
    executionRef.current?.controller.abort(
      new DOMException("Pane refresh target changed.", "AbortError"),
    );
    executionRef.current = null;
    setAnnouncement(null);
    commitState({ kind: "Idle" });
    return () => {
      touchRef.current = null;
      clearSettledTimer();
      executionRef.current?.controller.abort(
        new DOMException("Pane refresh target changed.", "AbortError"),
      );
      executionRef.current = null;
    };
  }, [clearSettledTimer, commitState, routeKey, sourceKey]);
  useEffect(() => {
    const scrollport = scrollportRef.current;
    if (!pullEnabled || !scrollport) {
      touchRef.current = null;
      if (
        stateRef.current.kind === "Pulling" ||
        stateRef.current.kind === "Armed"
      ) {
        commitState({ kind: "Idle" });
      }
      return;
    }

    const cancelPull = () => {
      touchRef.current = null;
      if (
        stateRef.current.kind === "Pulling" ||
        stateRef.current.kind === "Armed"
      ) {
        commitState({ kind: "Idle" });
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      if (
        event.touches.length !== 1 ||
        scrollport.scrollTop !== 0 ||
        executionRef.current !== null
      ) {
        cancelPull();
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      touchRef.current = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        intent: "Pending",
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      const tracked = touchRef.current;
      if (!tracked) return;
      if (event.touches.length !== 1 || scrollport.scrollTop !== 0) {
        cancelPull();
        return;
      }
      const touch = findTouch(event.touches, tracked.identifier);
      if (!touch) {
        cancelPull();
        return;
      }
      const deltaX = touch.clientX - tracked.startX;
      const deltaY = touch.clientY - tracked.startY;
      if (deltaY <= 0 || Math.abs(deltaX) >= deltaY) {
        cancelPull();
        return;
      }
      tracked.intent = "Downward";
      event.preventDefault();
      const offsetPx = Math.min(
        PANE_REFRESH_MAX_OFFSET_PX,
        deltaY * PANE_REFRESH_DRAG_RESISTANCE,
      );
      commitState(
        offsetPx >= PANE_REFRESH_ARM_DISTANCE_PX
          ? { kind: "Armed", offsetPx }
          : { kind: "Pulling", offsetPx },
      );
    };
    const onTouchEnd = () => {
      const tracked = touchRef.current;
      touchRef.current = null;
      if (!tracked) return;
      if (stateRef.current.kind === "Armed") {
        start();
        return;
      }
      if (stateRef.current.kind === "Pulling") {
        commitState({ kind: "Idle" });
      }
    };

    scrollport.addEventListener("touchstart", onTouchStart, { passive: true });
    scrollport.addEventListener("touchmove", onTouchMove, { passive: false });
    scrollport.addEventListener("touchend", onTouchEnd, { passive: true });
    scrollport.addEventListener("touchcancel", cancelPull, { passive: true });
    return () => {
      scrollport.removeEventListener("touchstart", onTouchStart);
      scrollport.removeEventListener("touchmove", onTouchMove);
      scrollport.removeEventListener("touchend", onTouchEnd);
      scrollport.removeEventListener("touchcancel", cancelPull);
      cancelPull();
    };
  }, [commitState, pullEnabled, scrollportRef, start]);

  if (asyncDefect !== null) throw asyncDefect.error;

  return {
    state,
    start,
    feedback: paneRefreshFeedback(state),
    offsetPx:
      state.kind === "Pulling" || state.kind === "Armed"
        ? state.offsetPx
        : state.kind === "Idle"
          ? 0
          : PANE_REFRESH_ARM_DISTANCE_PX,
    announcement,
  };
}
