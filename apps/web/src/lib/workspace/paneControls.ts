import { Copy, Minus, Square, X, type LucideIcon } from "lucide-react";
import type { WorkspaceState } from "@/lib/workspace/model";

export type PaneControl = {
  slot: "visibility" | "layout" | "close";
  command: "minimize" | "maximize" | "restore_canvas" | "close";
  icon: LucideIcon;
  label: string;
  tooltip: string;
  disabledReason: string | null;
};

/** Pure pane-management content; presenters own dispatch and focus. */
export function paneControls({
  state, paneId, title, desktopMaximized, isMobile,
}: {
  readonly state: WorkspaceState;
  readonly paneId: string;
  readonly title: string;
  readonly desktopMaximized: boolean;
  readonly isMobile: boolean;
}): PaneControl[] {
  const pane = state.panes.find((item) => item.id === paneId);
  if (!pane) return [];
  const minimized = pane.visibility === "minimized";
  const restore = {
    command: "restore_canvas",
    icon: Copy,
    label: `restore ${title} to layout`,
    tooltip: "return to multi-pane layout",
    disabledReason: null,
  } as const;
  const controls: PaneControl[] = [];
  if (!isMobile && minimized) {
    controls.push({ slot: "visibility", ...restore });
  } else if (!minimized) {
    controls.push({
      slot: "visibility",
      command: "minimize",
      icon: Minus,
      label: `minimize ${title}`,
      tooltip: "hide pane; keep it open",
      disabledReason: state.panes.filter((item) => item.visibility === "visible").length === 1
        ? "keep at least one pane visible" : null,
    });
  }
  if (!isMobile) {
    controls.push(desktopMaximized && state.active_primary_pane_id === paneId
      ? { slot: "layout", ...restore }
      : {
          slot: "layout",
          command: "maximize",
          icon: Square,
          label: `maximize ${title}`,
          tooltip: "show this pane alone",
          disabledReason: null,
        });
  }
  controls.push({
    slot: "close",
    command: "close",
    icon: X,
    label: `close ${title}`,
    tooltip: "close pane",
    disabledReason: null,
  });
  return controls;
}
