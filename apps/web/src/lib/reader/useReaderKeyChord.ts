"use client";

import { useEffect, useRef } from "react";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";

/**
 * A reader-local single-key chord, parameterized on the key — the modal
 * "focus-a-passage + one dedicated key" shape (D-11). Fires only while enabled
 * (a passage is focused, or a selection is live), never inside an editable
 * target, never with a modifier. Deliberately NOT a `BINDABLE_ACTIONS` entry —
 * that registry is app-global and its capture UI cannot record bare keys; these
 * chords must be dispatched where the selection state lives.
 */
export function useReaderKeyChord(args: {
  enabled: boolean;
  key: string;
  onTrigger: () => void;
}): void {
  const onTriggerRef = useRef(args.onTrigger);
  onTriggerRef.current = args.onTrigger;

  useEffect(() => {
    if (!args.enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== args.key) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      onTriggerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [args.enabled, args.key]);
}
