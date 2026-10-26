"use client";

import type { ResourceActivation } from "@/lib/resources/activation";
import { ActionMenuHost, ActionMenuInvocation, type ActionMenuProps, type ActionMenuSession } from "@/components/ui/ActionMenu";
import type { PodcastActionFocus } from "@/lib/actions/inlineActions";
import { useClientActions, useResourceActions } from "@/lib/actions/useResourceActions";
import { usePaneSubject } from "@/lib/panes/paneChrome";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useTouchCapable } from "@/lib/renderEnvironment/provider";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { MenuContent, MenuOption, MenuSource } from "@/lib/ui/actionDescriptor";

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly MenuOption[];
}

/**
 * One composer for a place and its resource principal. Publishes local pane,
 * occurrence or view choices and authoritative resource verbs as one complete
 * result; an optional source label names that principal. A supplied disabled
 * reason blocks commands.
 */
type ContextualMenuProps = Pick<ActionMenuProps,
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
};

export default function ContextualActionMenu(props: ContextualMenuProps) {
  const pane = usePaneRuntime();
  const subjectKey = `${pane?.visitId ?? "workspace"}:${props.subjectKey}:${props.resourceRef ?? "local"}:${JSON.stringify(props.displayedActivation ?? null)}`;
  return <ActionMenuHost {...props} title={props.title} subjectKey={subjectKey}>{session =>
    <ContextualMenuInvocation {...props} session={session} />
  }</ActionMenuHost>;
}

/** Authoritative facts and client subscriptions belong only to an invocation. */
function ContextualMenuInvocation({
  sections, resourceRef, title, subjectKey, onDefect, actionFocus,
  omitResourceActions = [], showSourceSubject = false, displayedActivation, commandDisabledReason, session, ...props
}: ContextualMenuProps & { readonly session: ActionMenuSession }) {
  const pane = usePaneRuntime();
  const paneSubject = usePaneSubject();
  const coarse = useTouchCapable();
  const resource = useResourceActions(resourceRef ?? null, onDefect, actionFocus);
  const state = resource.state;
  const client = useClientActions(resourceRef ?? null, title);
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
    // No open verbs where a displayed activation already opens the subject, or on the pane's own subject.
    const options = state.options.filter((action) => !omitResourceActions.includes(action.id)
      && !((displayedActivation || resourceRef === paneSubject) && ["Open", "OpenInNewPane"].includes(action.id)));
    if (options.length > 0) groups.push({
      id: "Resource", label: showSourceSubject ? `source: ${state.facts.label}` : "item", options,
    });
  }
  if (state?.kind === "Failed" && state.connectionRequired) groups.push({
    id: "Resource", label: null, options: [{ kind: "command", id: "Resource.ConnectionRequired", label: "requires a connection", disabled: true, onSelect: () => {} }],
  });
  // Client-owned facts compose beside the remote facts; a remote verb with the same id wins.
  const remote = new Set(state?.kind === "Ready" ? state.options.map(action => action.id) : []);
  const local = client.filter(action => !remote.has(action.id) && !omitResourceActions.includes(action.id));
  if (local.length > 0) groups.push({ id: "Device", label: "on this device", options: local });
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
  return <ActionMenuInvocation source={source} session={session} placement={props.placement} align={props.align} returnFocusTo={props.returnFocusTo} />;
}
