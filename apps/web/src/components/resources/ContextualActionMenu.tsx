"use client";

import type { ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useMobileChromeActionMenuLock } from "@/lib/workspace/useMobileChromeActionMenuLock";
import ResourceActionMenu from "./ResourceActionMenu";

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

function defectDuplicate(kind: "section" | "action", id: string): never {
  throw new Error(`Contextual action menu has duplicate ${kind} ID: ${id}`);
}

function defectLocalDanger(message: string): never {
  throw new Error(`Contextual action menu ${message}`);
}

function validateSections(
  sections: readonly ContextActionSection[],
): readonly ContextActionSection[] {
  const sectionIds = new Set<string>();
  const actionIds = new Set<string>();
  const nonEmpty: ContextActionSection[] = [];
  for (const section of sections) {
    if (sectionIds.has(section.id)) defectDuplicate("section", section.id);
    sectionIds.add(section.id);
    if (section.actions.length === 0) continue;
    for (const action of section.actions) {
      if (actionIds.has(action.id)) defectDuplicate("action", action.id);
      actionIds.add(action.id);
    }
    nonEmpty.push(section);
  }
  return nonEmpty;
}

function validateLocalDangerPolicy(
  sections: readonly ContextActionSection[],
  hasResourceSubject: boolean,
): void {
  for (const section of sections) {
    let dangerSeen = false;
    for (const action of section.actions) {
      if (action.tone === "danger") {
        if (hasResourceSubject) {
          defectLocalDanger(
            `local danger action ${action.id} cannot precede a resource-action suffix`,
          );
        }
        dangerSeen = true;
        continue;
      }
      if (dangerSeen) {
        defectLocalDanger(
          `action ${action.id} cannot follow a danger action in its section`,
        );
      }
    }
  }
}

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

function assertUniqueActionIds(actions: readonly ActionDescriptor[]): void {
  const ids = new Set<string>();
  for (const action of actions) {
    if (ids.has(action.id)) defectDuplicate("action", action.id);
    ids.add(action.id);
  }
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

function ComposedResourceActionMenu({
  actionSubject,
  local,
  ...props
}: Omit<ContextualActionMenuProps, "sections" | "actionSubject"> & {
  readonly actionSubject: ResourceActionSubject;
  readonly local: readonly ActionDescriptor[];
}) {
  const resource = useResourceActionMenuModel(actionSubject);
  const { onOpenChange } = useMobileChromeActionMenuLock();
  const resourceDescriptors =
    resource.status === "Loading"
      ? [resourceLoadingDescriptor()]
      : resource.descriptors;
  const suffix = resourceDescriptors.map((action, index) =>
    index === 0 ? { ...action, separatorBefore: true } : action,
  );
  const options = [...local, ...suffix];
  assertUniqueActionIds(options);

  return <ActionMenu {...props} options={options} onOpenChange={onOpenChange} />;
}

function LocalActionMenu({
  options,
  ...props
}: Omit<ContextualActionMenuProps, "sections" | "actionSubject"> & {
  readonly options: readonly ActionDescriptor[];
}) {
  const { onOpenChange } = useMobileChromeActionMenuLock();
  return <ActionMenu {...props} options={options} onOpenChange={onOpenChange} />;
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
  const nonEmptySections = validateSections(sections);
  validateLocalDangerPolicy(nonEmptySections, actionSubject !== undefined);
  const local = localDescriptors(nonEmptySections);

  if (!actionSubject) {
    return <LocalActionMenu {...props} options={local} />;
  }
  if (local.length === 0) {
    return <ResourceActionMenu actionSubject={actionSubject} {...props} />;
  }
  return (
    <ComposedResourceActionMenu
      {...props}
      actionSubject={actionSubject}
      local={local}
    />
  );
}
