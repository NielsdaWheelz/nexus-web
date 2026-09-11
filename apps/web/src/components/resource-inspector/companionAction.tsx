"use client";

// The ONE shared Companion disclosure action (A12/A14 §152) — the single header
// control that opens/closes a pane's secondary column across every eligible
// pane, desktop and mobile alike: the Resource Inspector on subject panes, the
// selected import's details on the Imports pane. Icon `panel-right-open`; when
// expanded its `controls` is that column's region id so
// `PaneShell`/`SurfaceHeader` render the correct pressed/disclosure state and
// keep the secondary mounted while visibility settles.
import { PanelRightOpen } from "lucide-react";
import type { ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import type { PaneCompanionAction } from "@/lib/panes/panePublications";

const COMPANION_MENU_LABELS = {
  collapsed: "Show Companion",
  expanded: "Hide Companion",
} as const;

export function companionAction({
  expanded,
  regionId,
  onOpen,
  onClose,
}: {
  expanded: boolean;
  /** `paneSecondaryRegionId(paneId, <the pane's secondary group>)`. */
  regionId: string;
  onOpen: (trigger: HTMLButtonElement | null) => void;
  onClose: () => void;
}): PaneCompanionAction {
  return {
    kind: "command",
    id: "resource-inspector-companion",
    label: "Companion",
    icon: <PanelRightOpen size={16} aria-hidden="true" />,
    // The opener owns focus return (it captures the trigger element and refocuses
    // it on close), so the menu/bar must not also restore focus.
    restoreFocusOnClose: false,
    state: expanded
      ? {
          kind: "disclosure",
          expanded: true,
          controls: regionId,
          menuLabels: COMPANION_MENU_LABELS,
        }
      : {
          kind: "disclosure",
          expanded: false,
          menuLabels: COMPANION_MENU_LABELS,
        },
    onSelect: (detail: ActionSelectDetail) => {
      if (expanded) onClose();
      else onOpen(detail.triggerEl);
    },
  };
}
