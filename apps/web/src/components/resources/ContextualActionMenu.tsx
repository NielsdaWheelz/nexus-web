"use client";

import type { ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import { useOptionalResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useMobileChromeActionMenuLock } from "@/lib/workspace/useMobileChromeActionMenuLock";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly ActionDescriptor[];
}

type ContextualActionMenuProps = Pick<
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
};

function localDescriptors(
  sections: readonly ContextActionSection[],
): readonly ActionDescriptor[] {
  return sections.flatMap((section, sectionIndex) =>
    section.actions.map((action, actionIndex) =>
      sectionIndex > 0 && actionIndex === 0
        ? { ...action, separatorBefore: true }
        : action,
    ),
  );
}

function resourceLoadingDescriptor(): ActionDescriptor {
  return {
    kind: "custom",
    id: "ContextualActionMenu.ResourceLoading",
    label: "Resource actions are loading…",
    render: () => (
      <button type="button" role="menuitem" disabled aria-disabled="true">
        Resource actions are loading…
      </button>
    ),
  };
}

/**
 * A presentation-only composition of pane, occurrence, or view commands with
 * the unchanged canonical resource plan. Resource policy remains in the
 * resource-action runtime and appears as an ordered contiguous suffix.
 */
export default function ContextualActionMenu({
  sections,
  actionSubject,
  ...props
}: ContextualActionMenuProps) {
  const local = localDescriptors(
    sections.filter((section) => section.actions.length > 0),
  );
  const resource = useOptionalResourceActionMenuModel(actionSubject);
  const { onOpenChange } = useMobileChromeActionMenuLock();
  const resourceDescriptors =
    resource === null
      ? []
      : resource.status === "Loading"
        ? local.length === 0
          ? []
          : [resourceLoadingDescriptor()]
        : resource.descriptors;
  const suffix = resourceDescriptors.map((action, index) =>
    index === 0 ? { ...action, separatorBefore: true } : action,
  );
  const options = [...local, ...suffix];
  const resourceOnly = actionSubject !== undefined && local.length === 0;

  return (
    <ActionMenu
      {...props}
      options={options}
      onOpenChange={onOpenChange}
      triggerDisabled={
        resourceOnly ? (resource?.triggerDisabled ?? true) : undefined
      }
      triggerDisabledReason={
        resourceOnly
          ? (resource?.triggerDisabledReason ?? "Actions are still loading.")
          : undefined
      }
    />
  );
}
