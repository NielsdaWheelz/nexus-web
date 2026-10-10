"use client";

import { useEffect } from "react";
import { matchesKeyEvent } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/keybindingsProvider";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import { useWorkspaceStore } from "@/lib/workspace/store";

/** pane-next / pane-previous move to the adjacent visible pane (clamped). */
export function useAdjacentPaneKeybindings({
  onActivated,
}: {
  readonly onActivated: (paneId: string) => void;
}): void {
  const { activateAdjacentPane } = useWorkspaceStore();
  const keybindings = useKeybindings();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const next = keybindings["pane-next"];
      const previous = keybindings["pane-previous"];
      const isNext = Boolean(next) && matchesKeyEvent(next, event);
      if (!isNext && !(previous && matchesKeyEvent(previous, event))) return;
      event.preventDefault();
      const result = activateAdjacentPane({
        direction: isNext ? "Next" : "Previous",
      });
      if (result.kind === "Activated") onActivated(result.paneId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activateAdjacentPane, keybindings, onActivated]);
}
