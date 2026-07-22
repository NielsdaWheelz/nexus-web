"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import { useContainingModalLayer } from "@/lib/ui/useModalLayer";

type DismissReason = "outside-click" | "escape";

/**
 * While `enabled`, dismiss a panel / menu / popover when the user either:
 *   - presses pointerdown on a target that is not contained in any of `refs`
 *     (`reason="outside-click"`)
 *   - presses Escape (`reason="escape"`)
 *
 * A pointerdown inside an element marked `data-dismiss-ignore` never counts as
 * outside — that marks a portaled child layer (e.g. a popover's color picker)
 * that is DOM-detached from its logical parent but must not dismiss it.
 *
 * The dismiss callback is read through a ref so the listeners attach once per
 * activation and the consumer doesn't have to memoize it. Pass the reason
 * back so callers can distinguish e.g. "Escape returns focus to the trigger"
 * from "click elsewhere lets the user click freely."
 *
 * Callers responsible for positioning / repositioning the panel keep that
 * logic in a separate effect — this hook only owns the dismiss listeners.
 */
export function useDismissOnOutsideOrEscape(args: {
  enabled: boolean;
  refs: Array<RefObject<HTMLElement | null>>;
  onDismiss: (reason: DismissReason) => void;
}): void {
  const { enabled, refs, onDismiss } = args;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const modalToken = useContainingModalLayer();

  useEscapeKey(enabled, () => onDismissRef.current("escape"), {
    layer: "transient",
    modalToken,
  });

  useEffect(() => {
    if (!enabled) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const ref of refsRef.current) {
        if (ref.current?.contains(target)) return;
      }
      const el = target instanceof Element ? target : target.parentElement;
      if (el?.closest("[data-dismiss-ignore]")) return;
      onDismissRef.current("outside-click");
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [enabled]);
}
