"use client";

// The popup presenter over one subject's contextual actions: ActionMenuHost plus useContextualActions.
import { ActionMenuHost, ActionMenuInvocation, type ActionMenuProps, type ActionMenuSession } from "@/components/ui/ActionMenu";
import { useContextualActions, type ContextualActionsInput } from "@/lib/actions/useContextualActions";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";

export type { ContextActionSection, DisplayedNavigation } from "@/lib/actions/useContextualActions";

type ContextualMenuProps = Pick<ActionMenuProps,
  "label" | "placement" | "align" | "onOpenChange" | "renderTrigger" | "triggerAttributes" | "triggerRef" | "returnFocusTo" | "renderContextAnchor" | "hold"
> & ContextualActionsInput;

export default function ContextualActionMenu(props: ContextualMenuProps) {
  const pane = usePaneRuntime();
  const subjectKey = `${pane?.visitId ?? "workspace"}:${props.subjectKey}:${props.resourceRef ?? "local"}:${props.navigation?.key ?? "resource-only"}`;
  return <ActionMenuHost {...props} title={props.title} subjectKey={subjectKey}>{session =>
    <ContextualMenuInvocation {...props} subjectKey={subjectKey} session={session} />
  }</ActionMenuHost>;
}

/** Authoritative facts and client subscriptions belong only to an invocation. */
function ContextualMenuInvocation({ session, placement, align, onOpenChange, returnFocusTo, ...input }: ContextualMenuProps & { readonly session: ActionMenuSession }) {
  const source = useContextualActions(input);
  return <ActionMenuInvocation source={source} session={session} placement={placement} align={align} onOpenChange={onOpenChange} returnFocusTo={returnFocusTo} />;
}
