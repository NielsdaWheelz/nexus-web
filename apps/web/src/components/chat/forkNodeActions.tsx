import { Check, Pencil, Trash2, X } from "lucide-react";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";

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
): ActionMenuOption[] {
  if (input.mode === "edit") {
    return [
      {
        id: "save",
        label: `Save fork ${input.title}`,
        icon: <Check size={14} aria-hidden="true" />,
        onSelect: input.onSaveRename,
      },
      {
        id: "cancel",
        label: `Cancel rename fork ${input.title}`,
        icon: <X size={14} aria-hidden="true" />,
        onSelect: input.onCancelRename,
      },
    ];
  }

  return [
    {
      id: "rename",
      label: `Rename fork ${input.title}`,
      icon: <Pencil size={14} aria-hidden="true" />,
      onSelect: input.onStartRename,
    },
    {
      id: "delete",
      label: `Delete fork ${input.title}`,
      icon: <Trash2 size={14} aria-hidden="true" />,
      disabled: input.deleteDisabled,
      onSelect: input.onRequestDelete,
    },
  ];
}
