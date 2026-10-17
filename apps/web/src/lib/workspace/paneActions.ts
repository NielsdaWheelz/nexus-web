import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { WorkspaceState } from "@/lib/workspace/model";

/** Shared tab management vocabulary; callers own commands and focus. */
export function paneActions({
  state,
  paneId,
  onMinimize,
  onRestore,
  onMove,
  onClose,
}: {
  readonly state: WorkspaceState;
  readonly paneId: string;
  readonly onMinimize: (paneId: string) => void;
  readonly onRestore: (paneId: string) => void;
  readonly onMove: (input: { paneId: string; beforePaneId: string | null }) => void;
  readonly onClose: (paneId: string) => void;
}): ActionDescriptor[] {
  const index = state.panes.findIndex((pane) => pane.id === paneId);
  const pane = state.panes[index];
  if (!pane) return [];
  const minimized = pane.visibility === "minimized";
  const lastVisible = !minimized &&
    state.panes.filter((item) => item.visibility === "visible").length === 1;
  const first = index === 0;
  const last = index === state.panes.length - 1;

  return [
    {
      id: minimized ? "pane-restore" : "pane-minimize",
      kind: "command",
      label: minimized ? "Restore pane" : "Minimize pane",
      disabled: lastVisible,
      disabledReason: lastVisible ? "Keep at least one pane visible." : undefined,
      onSelect: () => minimized ? onRestore(paneId) : onMinimize(paneId),
    },
    {
      id: "pane-move-earlier",
      kind: "command",
      label: "Move earlier",
      separatorBefore: true,
      disabled: first,
      disabledReason: first ? "Already the first tab." : undefined,
      onSelect: () => {
        if (!first) onMove({ paneId, beforePaneId: state.panes[index - 1]!.id });
      },
    },
    {
      id: "pane-move-later",
      kind: "command",
      label: "Move later",
      disabled: last,
      disabledReason: last ? "Already the last tab." : undefined,
      onSelect: () => {
        if (!last) onMove({ paneId, beforePaneId: state.panes[index + 2]?.id ?? null });
      },
    },
    {
      id: "pane-close",
      kind: "command",
      label: "Close tab",
      separatorBefore: true,
      restoreFocusOnClose: false,
      onSelect: () => onClose(paneId),
    },
  ];
}
