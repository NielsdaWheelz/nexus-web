import { Map } from "lucide-react";
import type {
  ActionControlState,
  ActionSelectDetail,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";

const DOCUMENT_MAP_MENU_LABELS = {
  collapsed: "Show Document Map",
  expanded: "Hide Document Map",
} as const satisfies Extract<
  ActionControlState,
  { kind: "disclosure" }
>["menuLabels"];

export function documentMapAction(input: {
  readonly expanded: boolean;
  readonly regionId: string;
  readonly onToggle: (detail: ActionSelectDetail) => void;
}): PaneHeaderAction {
  return {
    kind: "command",
    id: "document-map",
    label: "Document Map",
    icon: <Map size={16} aria-hidden="true" />,
    state: input.expanded
      ? {
          kind: "disclosure",
          expanded: true,
          controls: input.regionId,
          menuLabels: DOCUMENT_MAP_MENU_LABELS,
        }
      : {
          kind: "disclosure",
          expanded: false,
          menuLabels: DOCUMENT_MAP_MENU_LABELS,
        },
    restoreFocusOnClose: false,
    onSelect: input.onToggle,
  };
}
