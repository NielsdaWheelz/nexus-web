"use client";

import { useEffect } from "react";
import { assertNever } from "@/lib/assertNever";
import { matchesKeyEvent } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/keybindingsProvider";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import { useWorkspaceStore } from "@/lib/workspace/store";

export function useAdjacentPaneKeybindings({
  onActivated,
}: {
  readonly onActivated: (paneId: string) => void;
}): void {
  const { activateAdjacentPane } = useWorkspaceStore();
  const keybindings = useKeybindings();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      const nextCombo = keybindings["pane-next"];
      const previousCombo = keybindings["pane-previous"];
      const isNext = Boolean(nextCombo) && matchesKeyEvent(nextCombo, event);
      const isPrevious =
        Boolean(previousCombo) && matchesKeyEvent(previousCombo, event);
      if (!isNext && !isPrevious) {
        return;
      }
      event.preventDefault();
      const result = activateAdjacentPane({
        direction: isNext ? "Next" : "Previous",
      });
      switch (result.kind) {
        case "Activated":
          onActivated(result.paneId);
          return;
        case "Unchanged":
          return;
      }
      return assertNever(result, "Unreachable adjacent pane activation result");
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activateAdjacentPane, keybindings, onActivated]);
}
