"use client";

import { useCallback, useState, type ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import {
  NO_ACTIONS,
  useResourceActionMenu,
} from "@/lib/actions/useResourceActionMenu";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly ActionDescriptor[];
}

/** Pane, occurrence or view commands, then the resource's verbs after a separator. */
export default function ContextualActionMenu({
  sections,
  actionSubject,
  onDefect,
  ...props
}: Pick<
  ActionMenuProps,
  | "label"
  | "placement"
  | "align"
  | "renderTrigger"
  | "triggerAttributes"
  | "triggerRef"
> & {
  readonly sections: readonly ContextActionSection[];
  readonly actionSubject?: ResourceActionSubject;
  /** Where a defect while loading goes when the menu renders outside its pane. */
  readonly onDefect?: (defect: { readonly error: unknown }) => void;
}) {
  const { options: resource, onOpenChange } = useResourceActionMenu(
    actionSubject?.ref ?? null,
    onDefect,
  );
  const [open, setOpen] = useState(false);
  useMobileChromeHold(open);
  const openChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
    },
    [onOpenChange],
  );
  const local = sections.map((section) => section.actions);
  // A resource-only menu with no verbs still says so.
  const alone = actionSubject && !local.some((actions) => actions.length > 0);
  const verbs = alone && resource.length === 0 ? [NO_ACTIONS] : resource;
  const options = [...local, verbs]
    .filter((actions) => actions.length > 0)
    .flatMap((actions, group) =>
      actions.map((action, index) =>
        group > 0 && index === 0 ? { ...action, separatorBefore: true } : action,
      ),
    );
  return <ActionMenu {...props} options={options} onOpenChange={openChange} />;
}
