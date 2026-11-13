import * as Icon from "@/lib/ui/icons";
import type { WorkspaceState } from "@/lib/workspace/model";

/** Active-pane management content; the strip owns dispatch and focus. */
export function activePaneControls({ state, title, desktopMaximized }: {
  readonly state: WorkspaceState;
  readonly title: string;
  readonly desktopMaximized: boolean;
}) {
  return [
    {
      slot: "visibility",
      command: "minimize",
      icon: Icon.Remove,
      label: `Minimize ${title}`,
      tooltip: "hide pane; keep it open",
      disabledReason: state.panes.filter(item => item.visibility === "visible").length === 1
        ? "keep at least one pane visible" : null,
    },
    desktopMaximized ? {
      slot: "layout",
      command: "restore_canvas",
      icon: Icon.Restore,
      label: `Restore ${title} to layout`,
      tooltip: "return to multi-pane layout",
      disabledReason: null,
    } as const : {
      slot: "layout",
      command: "maximize",
      icon: Icon.Maximize,
      label: `Maximize ${title}`,
      tooltip: "show this pane alone",
      disabledReason: null,
    } as const,
  ] as const;
}
