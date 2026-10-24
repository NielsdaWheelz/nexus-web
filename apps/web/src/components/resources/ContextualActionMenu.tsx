"use client";

import { useEffect, useState, type ComponentProps } from "react";
import type { ResourceActivation } from "@/lib/resources/activation";
import ActionMenu from "@/components/ui/ActionMenu";
import type { PodcastActionFocus } from "@/lib/actions/inlineActions";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor, MenuContent, MenuSource } from "@/lib/ui/actionDescriptor";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly ActionDescriptor[];
}

/**
 * One composer for a place and its resource principal. Publishes local pane,
 * occurrence or view choices and authoritative resource verbs as one complete
 * result; an optional source label names that principal. A supplied disabled
 * reason blocks commands.
 */
export default function ContextualActionMenu({
  sections, resourceRef, title, subjectKey, onDefect, actionFocus,
  omitResourceActions = [], showSourceSubject = false, displayedActivation, commandDisabledReason, ...props
}: Pick<ActionMenuProps,
  "label" | "placement" | "align" | "renderTrigger" | "triggerAttributes" | "triggerRef" | "returnFocusTo" | "renderContextAnchor"
> & {
  readonly actionFocus?: PodcastActionFocus;
  readonly title: string;
  readonly subjectKey: string;
  readonly sections: readonly ContextActionSection[];
  readonly resourceRef?: CanonicalResourceRef;
  readonly omitResourceActions?: readonly string[];
  readonly showSourceSubject?: boolean;
  readonly displayedActivation?: ResourceActivation;
  readonly commandDisabledReason?: string;
  /** Loading defects belong to the resource's pane, even outside its provider. */
  readonly onDefect?: (defect: { readonly error: unknown }) => void;
}) {
  const pane = usePaneRuntime();
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(any-pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const resource = useResourceActions(resourceRef ?? null, onDefect, actionFocus);
  const state = resource.state;
  const groups: MenuContent["sections"][number][] = sections
    .filter((section) => section.actions.length > 0)
    .map((section) => ({ id: section.id, label: {
      Pane: "pane", Occurrence: "this occurrence", View: "view",
    }[section.id], options: section.actions }));
  if (coarse && displayedActivation?.kind === "route" && displayedActivation.href && pane) {
    const href = displayedActivation.href;
    groups.push({ id: "Navigation", label: null, options: [{
      kind: "link", id: "Row.OpenInNewPane", label: "open in new pane", href,
      disabled: Boolean(commandDisabledReason), disabledReason: commandDisabledReason,
      restoreFocusOnClose: false,
      onActivate: event => {
        const result = activateTargetLink({ event, target: { href, labelHint: title },
          runtime: { activateTarget: input => pane.activateTarget({ ...input, disposition: { kind: "Fork" } }) },
        });
        return result === "handled-default" ? "handled-new-pane" : result;
      },
    }] });
  }
  if (state?.kind === "Ready") {
    const options = state.options.filter((action) => !omitResourceActions.includes(action.id) && !(displayedActivation && ["Open", "OpenInNewPane"].includes(action.id)));
    if (options.length > 0) groups.push({
      id: "Resource", label: showSourceSubject ? `source: ${state.facts.label}` : "item", options,
    });
  }
  if (state?.kind === "Failed" && state.connectionRequired) groups.push({
    id: "Resource", label: null, options: [{ kind: "command", id: "Resource.ConnectionRequired", label: "requires a connection", disabled: true, onSelect: () => {} }],
  });
  const content: MenuContent = { sections: groups.map((section) => ({
    ...section,
    label: groups.length > 1 || (showSourceSubject && section.id === "Resource") ? section.label : null,
    options: section.options.map((action) => commandDisabledReason && action.kind === "command"
      ? { ...action, disabled: true, disabledReason: commandDisabledReason } : action),
  })) };
  const identity = { title, subjectKey: `${pane?.visitId ?? "workspace"}:${subjectKey}:${resourceRef ?? "local"}:${JSON.stringify(displayedActivation ?? null)}` };
  const source: MenuSource = resourceRef ? {
    ...identity, kind: "Prepared", prepare: resource.prepare,
    state: state?.kind === "Ready" || state?.kind === "Failed" && state.connectionRequired ? { kind: "Ready", request: state.request, content } : state,
  } : { ...identity, kind: "Immediate", content };
  return <ActionMenu {...props} label={props.label ?? `more actions for ${title}`} source={source} />;
}
