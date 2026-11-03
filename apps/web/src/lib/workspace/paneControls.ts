import * as Icon from "@/lib/ui/icons";
import type { WorkspaceState } from "@/lib/workspace/model";

export type PaneControl = {
  slot: "visibility" | "layout" | "close";
  command: "minimize" | "maximize" | "restore_canvas" | "close";
  icon: Icon.Glyph;
  label: string;
  tooltip: string;
  disabledReason: string | null;
};

/** Pure pane-management content; presenters own dispatch and focus. */
export function paneControls({
  state, paneId, title, desktopMaximized,
}: {
  readonly state: WorkspaceState;
  readonly paneId: string;
  readonly title: string;
  readonly desktopMaximized: boolean;
}): PaneControl[] {
  const pane = state.panes.find((item) => item.id === paneId);
  if (!pane) return [];
  const minimized = pane.visibility === "minimized";
  // one command, two signs, each the inverse of the state it ends: a minimized pane
  // comes back (Add), a maximized pane rejoins the others (Restore).
  const restore = {
    command: "restore_canvas",
    label: `Restore ${title} to layout`,
    tooltip: "return to multi-pane layout",
    disabledReason: null,
  } as const;
  const controls: PaneControl[] = [];
  if (minimized) {
    controls.push({ slot: "visibility", ...restore, icon: Icon.Add });
  } else {
    controls.push({
      slot: "visibility",
      command: "minimize",
      icon: Icon.Remove,
      label: `Minimize ${title}`,
      tooltip: "hide pane; keep it open",
      disabledReason: state.panes.filter((item) => item.visibility === "visible").length === 1
        ? "keep at least one pane visible" : null,
    });
  }
  controls.push(desktopMaximized && state.active_primary_pane_id === paneId
    ? { slot: "layout", ...restore, icon: Icon.Restore }
    : {
        slot: "layout",
        command: "maximize",
        icon: Icon.Maximize,
        label: `Maximize ${title}`,
        tooltip: "show this pane alone",
        disabledReason: null,
      });
  controls.push({
    slot: "close",
    command: "close",
    icon: Icon.Dismiss,
    label: `Close ${title}`,
    tooltip: "close pane",
    disabledReason: null,
  });
  return controls;
}
