"use client";

import { useEffect, useRef } from "react";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";

export const PLAYER_SHORTCUTS_DISABLED_SELECTOR = "[data-player-shortcuts-disabled]";

const INTERACTIVE_TARGET_SELECTOR = [
  "a[href]",
  "audio[controls]",
  "button",
  "input",
  "select",
  "summary",
  "textarea",
  "video[controls]",
  "[contenteditable]",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='gridcell']",
  "[role='link']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='treeitem']",
  "[tabindex]",
].join(",");

/**
 * Bind document keyboard shortcuts to the global player while a session is
 * loaded:
 *   - Space            : toggle play/pause
 *   - ArrowLeft        : `onSkipBackward`
 *   - ArrowRight       : `onSkipForward`
 *   - Shift+ArrowLeft  : `onPrevious` (device history / restart)
 *   - Shift+ArrowRight : `onNext` (manual next)
 *
 * No-ops for handled events, unsupported modifiers, interactive/editable
 * targets, and player-shortcut disabled scopes. Handlers are read through a ref
 * so callers do not have to memoize them.
 */
export function usePlayerKeyboardShortcuts(args: {
  enabled: boolean;
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onPrevious: () => void;
  onNext: () => void;
}): void {
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const live = argsRef.current;
      if (
        !live.enabled ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      if (
        event.target instanceof Element &&
        (event.target.closest(PLAYER_SHORTCUTS_DISABLED_SELECTOR) ||
          event.target.closest(INTERACTIVE_TARGET_SELECTOR))
      ) {
        return;
      }

      const isSpaceKey =
        event.key === " " ||
        event.key === "Spacebar" ||
        event.code === "Space";
      if (isSpaceKey) {
        if (event.shiftKey) {
          return;
        }
        event.preventDefault();
        if (live.isPlaying) {
          live.pause();
        } else {
          live.play();
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (event.shiftKey) {
          live.onPrevious();
        } else {
          live.onSkipBackward();
        }
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (event.shiftKey) {
          live.onNext();
        } else {
          live.onSkipForward();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
