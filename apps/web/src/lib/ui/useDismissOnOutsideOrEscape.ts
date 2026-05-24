"use client";

import { useEffect, useRef, type RefObject } from "react";

export type DismissReason = "outside-click" | "escape";

/**
 * While `enabled`, dismiss a panel / menu / popover when the user either:
 *   - presses pointerdown on a target that is not contained in any of `refs`
 *     (`reason="outside-click"`)
 *   - presses Escape (`reason="escape"`)
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

  useEffect(() => {
    if (!enabled) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const ref of refsRef.current) {
        if (ref.current?.contains(target)) return;
      }
      onDismissRef.current("outside-click");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismissRef.current("escape");
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled]);
}
