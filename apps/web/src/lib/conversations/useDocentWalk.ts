"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { CitationOut } from "@/lib/conversations/citationOut";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";
import { hasActiveInteractionOwner } from "@/lib/ui/useEscapeKey";
import { docentReducer, DOCENT_IDLE, type DocentWalkState } from "./docentWalk";

export function useDocentWalk({
  activateTarget,
}: {
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: { kind: "Adopt" };
  }) => void;
}): {
  walk: DocentWalkState;
  startWalk: (citations: CitationOut[], messageText: string) => void;
  next: () => void;
  prev: () => void;
  leave: () => void;
} {
  const [walk, dispatch] = useReducer(docentReducer, DOCENT_IDLE);

  const startWalk = useCallback((citations: CitationOut[], messageText: string) => {
    dispatch({ type: "start", citations, messageText });
  }, []);

  const next = useCallback(() => {
    dispatch({ type: "next" });
  }, []);

  const prev = useCallback(() => {
    dispatch({ type: "prev" });
  }, []);

  const leave = useCallback(() => {
    dispatch({ type: "leave" });
  }, []);

  // Stable refs for values used inside effects to avoid spurious re-fires.
  const walkStepsRef = useRef(walk.steps);
  walkStepsRef.current = walk.steps;
  const activateTargetRef = useRef(activateTarget);
  activateTargetRef.current = activateTarget;

  // Tracks the last (status, index, epoch) that drove a pane transition so we
  // don't re-fire when target activation identity changes between renders,
  // while still re-driving when a fresh walk starts at the same (status, index).
  const prevDrivenRef = useRef<{
    status: string;
    index: number;
    epoch: number;
  } | null>(null);

  // Pane-driving effect: fires when the walk step (or the walk itself) changes.
  useEffect(() => {
    if (walk.status !== "active") {
      prevDrivenRef.current = null;
      return;
    }
    const lastDriven = prevDrivenRef.current;
    if (
      lastDriven?.status === walk.status &&
      lastDriven?.index === walk.index &&
      lastDriven?.epoch === walk.epoch
    ) {
      return;
    }
    prevDrivenRef.current = {
      status: walk.status,
      index: walk.index,
      epoch: walk.epoch,
    };

    const step = walkStepsRef.current[walk.index];
    if (!step?.href) return;

    activateTargetRef.current({
      target: { href: step.href, labelHint: step.title },
      disposition: { kind: "Adopt" },
    });
  }, [walk.status, walk.index, walk.epoch]);

  // Keyboard effect: scoped to walk-active only (modal shortcuts, not global).
  useEffect(() => {
    if (walk.status !== "active") return;

    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasActiveInteractionOwner()) return;
      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      switch (event.key) {
        case "n":
        case "ArrowRight":
          event.preventDefault();
          dispatch({ type: "next" });
          break;
        case "p":
        case "ArrowLeft":
          event.preventDefault();
          dispatch({ type: "prev" });
          break;
        case "Escape":
          event.preventDefault();
          dispatch({ type: "leave" });
          break;
      }
    };

    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
    };
  }, [walk.status]);

  return { walk, startWalk, next, prev, leave };
}
