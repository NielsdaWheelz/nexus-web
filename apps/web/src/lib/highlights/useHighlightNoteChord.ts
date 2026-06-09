"use client";

import { useEffect, useRef } from "react";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";

/**
 * Reader-local bare-`n` chord: while a reader text selection is active, `n`
 * triggers the note verb. Deliberately NOT a `BINDABLE_ACTIONS` entry — that
 * registry is app-global and its capture UI cannot record bare keys; this
 * chord must be dispatched where the selection state lives.
 */
export function useHighlightNoteChord(args: {
  enabled: boolean;
  onTrigger: () => void;
}): void {
  const onTriggerRef = useRef(args.onTrigger);
  onTriggerRef.current = args.onTrigger;

  useEffect(() => {
    if (!args.enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "n") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      onTriggerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [args.enabled]);
}
