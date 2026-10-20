"use client";

import type { ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor, MenuContent, MenuSource } from "@/lib/ui/actionDescriptor";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly ActionDescriptor[];
}

/** Publishes local and resource sections together after the resource facts arrive. */
export default function ContextualActionMenu({
  sections, resourceRef, title, subjectKey, onDefect,
  omitResourceActions = [], showSourceSubject = false, commandDisabledReason, ...props
}: Pick<ActionMenuProps,
  "label" | "placement" | "align" | "renderTrigger" | "triggerAttributes" | "triggerRef" | "returnFocusTo"
> & {
  readonly title: string;
  readonly subjectKey: string;
  readonly sections: readonly ContextActionSection[];
  readonly resourceRef?: CanonicalResourceRef;
  readonly omitResourceActions?: readonly string[];
  readonly showSourceSubject?: boolean;
  readonly commandDisabledReason?: string;
  /** Loading defects belong to the resource's pane, even outside its provider. */
  readonly onDefect?: (defect: { readonly error: unknown }) => void;
}) {
  const pane = usePaneRuntime();
  const resource = useResourceActions(resourceRef ?? null, onDefect);
  const state = resource.state;
  const groups: MenuContent["sections"][number][] = sections
    .filter((section) => section.actions.length > 0)
    .map((section) => ({ id: section.id, label: {
      Pane: "pane", Occurrence: "this occurrence", View: "view",
    }[section.id], options: section.actions }));
  if (state?.kind === "Ready") {
    const options = state.options.filter((action) => !omitResourceActions.includes(action.id));
    if (options.length > 0) groups.push({
      id: "Resource", label: showSourceSubject ? `source: ${state.facts.label}` : "item", options,
    });
  }
  const content: MenuContent = { sections: groups.map((section) => ({
    ...section,
    label: groups.length > 1 || (showSourceSubject && section.id === "Resource") ? section.label : null,
    options: section.options.map((action) => commandDisabledReason && action.kind === "command"
      ? { ...action, disabled: true, disabledReason: commandDisabledReason } : action),
  })) };
  const identity = { title, subjectKey: `${pane?.visitId ?? "workspace"}:${subjectKey}:${resourceRef ?? "local"}` };
  const source: MenuSource = resourceRef ? {
    ...identity, kind: "Prepared", prepare: resource.prepare,
    state: state?.kind === "Ready" ? { kind: "Ready", request: state.request, content } : state,
  } : { ...identity, kind: "Immediate", content };
  return <ActionMenu {...props} label={props.label ?? `more actions for ${title}`} source={source} />;
}
