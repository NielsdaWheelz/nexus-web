"use client";

import { useEffect } from "react";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { matchesShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import { useWorkspaceStore } from "@/lib/workspace/store";

/** pane-next / pane-previous move to the adjacent visible pane (clamped). */
export function useAdjacentPaneKeybindings({
  onActivated,
}: {
  readonly onActivated: (paneId: string) => void;
}): void {
  const { activateAdjacentPane } = useWorkspaceStore();
  const { platform } = useRenderEnvironment();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || hasActiveInteractionOwner()) return;
      const isNext = matchesShortcut(SHORTCUTS["pane-next"], event, platform);
      if (!isNext && !matchesShortcut(SHORTCUTS["pane-previous"], event, platform)) return;
      event.preventDefault();
      const result = activateAdjacentPane({
        direction: isNext ? "Next" : "Previous",
      });
      if (result.kind === "Activated") onActivated(result.paneId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activateAdjacentPane, platform, onActivated]);
}
