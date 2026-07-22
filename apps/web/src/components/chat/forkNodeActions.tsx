import { Check, Pencil, Trash2, X } from "lucide-react";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";

export function buildForkNodeActions(
  input:
    | {
        mode: "view";
        title: string;
        deleteDisabled: boolean;
        onStartRename: () => void;
        onRequestDelete: () => void;
      }
    | {
        mode: "edit";
        title: string;
        onSaveRename: () => void;
        onCancelRename: () => void;
      },
): PaneHeaderAction[] {
  if (input.mode === "edit") {
    return [
      {
        kind: "command",
        id: "save",
        label: `Save fork ${input.title}`,
        icon: <Check size={14} aria-hidden="true" />,
        onSelect: input.onSaveRename,
      },
      {
        kind: "command",
        id: "cancel",
        label: `Cancel rename fork ${input.title}`,
        icon: <X size={14} aria-hidden="true" />,
        onSelect: input.onCancelRename,
      },
    ];
  }

  return [
    {
      kind: "command",
      id: "rename",
      label: `Rename fork ${input.title}`,
      icon: <Pencil size={14} aria-hidden="true" />,
      onSelect: input.onStartRename,
    },
    {
      kind: "command",
      id: "delete",
      label: `Delete fork ${input.title}`,
      icon: <Trash2 size={14} aria-hidden="true" />,
      disabled: input.deleteDisabled,
      onSelect: input.onRequestDelete,
    },
  ];
}
