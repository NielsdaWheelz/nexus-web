"use client";

import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { isNestedInteractiveTarget } from "@/lib/ui/isNestedInteractiveTarget";

const SWIPE_START_PX = 12; // horizontal travel before we treat the gesture as a swipe
const SWIPE_TRIGGER_PX = 96; // release past this fires the action

interface RowSwipe {
  offset: number;
  handlers:
    | {
        onPointerDown: (event: ReactPointerEvent) => void;
        onPointerMove: (event: ReactPointerEvent) => void;
        onPointerUp: () => void;
        onPointerCancel: () => void;
      }
    | undefined;
}

/**
 * Touch-only left-swipe-to-action, adapting the MobileSheet pointer-capture
 * pattern. Disambiguates from tap (needs > SWIPE_START_PX of horizontal travel)
 * and from vertical scroll (yields when the drag is mostly vertical), so it never
 * steals a tap-to-open or a scroll. Returns the live offset for a transform and
 * the pointer handlers; `undefined` handlers when there is no action to fire.
 */
export function useRowSwipe(onSwipe: (() => void) | undefined): RowSwipe {
  const start = useRef<{ x: number; y: number } | null>(null);
  const active = useRef(false);
  const offsetRef = useRef(0);
  const [offset, setOffset] = useState(0);

  if (!onSwipe) {
    return { offset: 0, handlers: undefined };
  }

  const reset = () => {
    start.current = null;
    active.current = false;
    offsetRef.current = 0;
    setOffset(0);
  };

  return {
    offset,
    handlers: {
      onPointerDown: (event) => {
        if (event.pointerType !== "touch") return;
        const primarySurface =
          event.target instanceof Element
            ? event.target.closest("[data-row-focusable]")
            : null;
        if (isNestedInteractiveTarget(event.target, primarySurface)) {
          reset();
          return;
        }
        start.current = { x: event.clientX, y: event.clientY };
        active.current = false;
      },
      onPointerMove: (event) => {
        if (start.current === null) return;
        const dx = event.clientX - start.current.x;
        const dy = event.clientY - start.current.y;
        if (!active.current) {
          if (Math.abs(dy) > Math.abs(dx)) {
            start.current = null; // vertical → let the scroll happen
            return;
          }
          if (Math.abs(dx) < SWIPE_START_PX) return;
          active.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        offsetRef.current = Math.min(0, dx);
        setOffset(offsetRef.current);
      },
      onPointerUp: () => {
        if (active.current && offsetRef.current <= -SWIPE_TRIGGER_PX) {
          onSwipe();
        }
        reset();
      },
      onPointerCancel: reset,
    },
  };
}
