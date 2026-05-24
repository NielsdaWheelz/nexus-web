"use client";

import { useEffect, useRef } from "react";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";

/**
 * Bind document keyboard shortcuts to the global player while a track is
 * loaded:
 *   - Space      : toggle play/pause
 *   - ArrowLeft  : `onSkipBackward`
 *   - ArrowRight : `onSkipForward`
 *
 * No-ops when the active element is editable (text input, textarea,
 * contenteditable). Handlers are read through a ref so callers don't have to
 * memoize them.
 */
export function usePlayerKeyboardShortcuts(args: {
  enabled: boolean;
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
}): void {
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const live = argsRef.current;
      if (!live.enabled) return;
      if (isEditableTarget(event.target)) return;

      const isSpaceKey =
        event.key === " " ||
        event.key === "Spacebar" ||
        event.code === "Space";
      if (isSpaceKey) {
        event.preventDefault();
        if (live.isPlaying) live.pause();
        else live.play();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        live.onSkipBackward();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        live.onSkipForward();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
