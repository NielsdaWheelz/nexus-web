"use client";

import { useCallback, useState } from "react";
import { isStaleBuild } from "@/lib/api/client";
import { ActionMenuHost, ActionMenuInvocation, type ActionMenuProps, type ActionMenuSession } from "@/components/ui/ActionMenu";
import type { PodcastActionFocus } from "@/lib/actions/inlineActions";
import { AUTHORED_ACTION_IDS, useAuthoredActions } from "@/lib/actions/useAuthoredActions";
import { useClientActions, useResourceActions } from "@/lib/actions/useResourceActions";
import { usePaneSubject } from "@/lib/panes/paneChrome";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor, MenuContent, MenuOption, MenuSource, TrailingState } from "@/lib/ui/actionDescriptor";

export type DisplayedNavigation = {
  readonly key: string;
  readonly fork: Extract<ActionDescriptor, { kind: "link" }> | null;
};

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly MenuOption[];
}

/**
 * A caller's known navigation and occurrence/view choices publish immediately.
 * Authoritative resource verbs retain their prepared snapshot and source label.
 * A supplied disabled reason blocks commands. An owned authored principal publishes
 * its local verbs as soon as one local read settles; the server's verbs settle in the
 * menu's trailing region (loading, ready or failed), never gating, reordering or
 * replacing the local snapshot.
 */
type ContextualMenuProps = Pick<ActionMenuProps,
  "label" | "placement" | "align" | "onOpenChange" | "renderTrigger" | "triggerAttributes" | "triggerRef" | "returnFocusTo" | "renderContextAnchor"
> & {
  readonly actionFocus?: PodcastActionFocus;
  readonly title: string;
  readonly subjectKey: string;
  readonly sections: readonly ContextActionSection[];
  readonly resourceRef?: CanonicalResourceRef;
  readonly omitResourceActions?: readonly string[];
  readonly showSourceSubject?: boolean;
  readonly navigation: DisplayedNavigation | null;
  readonly commandDisabledReason?: string;
  /** Loading defects belong to the resource's pane, even outside its provider. */
  readonly onDefect?: (defect: { readonly error: unknown }) => void;
};

export default function ContextualActionMenu(props: ContextualMenuProps) {
  const pane = usePaneRuntime();
  const subjectKey = `${pane?.visitId ?? "workspace"}:${props.subjectKey}:${props.resourceRef ?? "local"}:${props.navigation?.key ?? "resource-only"}`;
  return <ActionMenuHost {...props} title={props.title} subjectKey={subjectKey}>{session =>
    <ContextualMenuInvocation {...props} subjectKey={subjectKey} session={session} />
  }</ActionMenuHost>;
}

/** Authoritative facts and client subscriptions belong only to an invocation. */
function ContextualMenuInvocation({
  sections, resourceRef, title, subjectKey, onDefect, actionFocus,
  omitResourceActions = [], showSourceSubject = false, navigation, commandDisabledReason, session, ...props
}: ContextualMenuProps & { readonly session: ActionMenuSession }) {
  const paneSubject = usePaneSubject();
  const resource = useResourceActions(resourceRef ?? null, onDefect, actionFocus);
  const state = resource.state;
  const client = useClientActions(resourceRef ?? null, title);
  const authored = useAuthoredActions(resourceRef ?? null);
  const [request, setRequest] = useState<AbortSignal | null>(null);
  const prepareAuthored = authored.prepare, prepareRemote = resource.prepare;
  const prepare = useCallback((signal: AbortSignal) => {
    setRequest(signal);
    prepareAuthored(signal);
    prepareRemote(signal);
  }, [prepareAuthored, prepareRemote]);
  const blocked = (action: MenuOption): MenuOption => commandDisabledReason && action.kind === "command"
    ? { ...action, disabled: true, disabledReason: commandDisabledReason } : action;
  const initial: MenuContent = { sections: [
    ...sections.filter(section => section.actions.length > 0).map(section => ({ id: section.id, label: null, options: section.actions.map(blocked) })),
    ...(navigation?.fork ? [{ id: "Navigation", label: null, options: [navigation.fork] }] : []),
  ] };
  const groups: MenuContent["sections"][number][] = [];
  // An owned authored resource publishes its local verbs once the local read settles; the
  // server's facts settle separately in the trailing region and cannot gate them.
  const local = request !== null && authored.read?.request === request ? authored.read : null;
  // A caller that omits every local verb gets the server-backed menu, whose copies it omits too.
  const verbs = local?.actions.filter((action) => !omitResourceActions.includes(action.id)) ?? [];
  const owned = local !== null && verbs.length > 0;
  const remote = state !== null && state.request === request ? state : null;
  if (owned && local.label === null) throw new Error("local resource actions require their resource label");
  if (owned) {
    groups.push({ id: "Resource", label: showSourceSubject ? `source: ${local.label}` : null, options: verbs });
  } else if (remote?.kind === "Ready") {
    const options = remote.options.filter((action) => !omitResourceActions.includes(action.id) && !((navigation !== null || resourceRef === paneSubject) && ["Open", "OpenInNewPane"].includes(action.id)));
    if (options.length > 0) groups.push({
      id: "Resource", label: showSourceSubject ? `source: ${remote.facts.label}` : null, options,
    });
  }
  // Client-owned facts compose beside the remote facts; a remote verb with the same id wins.
  // A published local snapshot cannot depend on server facts that settle after it.
  const remoteIds = new Set(!owned && remote?.kind === "Ready" ? remote.options.map(action => action.id) : []);
  const device = client.filter(action => !remoteIds.has(action.id) && !omitResourceActions.includes(action.id));
  if (device.length > 0) groups.push({ id: "Device", label: null, options: device });
  const blockedRemote = (action: ActionDescriptor): ActionDescriptor => commandDisabledReason && action.kind === "command"
    ? { ...action, disabled: true, disabledReason: commandDisabledReason } : action;
  const content: MenuContent = { sections: groups.map((section) => ({
    ...section,
    options: section.options.map(blocked),
  })) };
  const identity = { title, subjectKey };
  const trailingFailure = remote?.kind === "Failed" ? remote : remote?.kind === "Loading" ? remote.failure : null;
  const trailing: TrailingState = request === null ? null : remote?.kind === "Ready" ? {
    kind: "Ready", request, label: showSourceSubject && owned ? `source: ${local.label}` : null,
    options: remote.options.filter((action) => !omitResourceActions.includes(action.id) &&
      !((navigation !== null || resourceRef === paneSubject) && ["Open", "OpenInNewPane"].includes(action.id)) && !AUTHORED_ACTION_IDS.has(action.id)).map(blockedRemote),
  } : trailingFailure ? {
    kind: "Failed", request, feedback: trailingFailure.feedback, pending: remote?.kind === "Loading",
    retry: trailingFailure.error && isStaleBuild(trailingFailure.error) ? null : () => resource.prepare(request),
  } : { kind: "Loading", request };
  // Verified device actions remain usable while the same remote owner retries.
  const source: MenuSource = !resourceRef ? { ...identity, kind: "Immediate", content: initial }
    : local !== null && (owned || device.length > 0 && trailing?.kind === "Failed")
      ? { ...identity, kind: "Prepared", initial, prepare, state: { kind: "Ready", request: local.request, content }, trailing }
    : {
      ...identity, kind: "Prepared", initial, prepare,
      state: request === null ? null : local === null ? { kind: "Loading", request }
        : remote?.kind === "Ready" ? { kind: "Ready", request, content } : remote,
    };
  return <ActionMenuInvocation source={source} session={session} placement={props.placement} align={props.align} onOpenChange={props.onOpenChange} returnFocusTo={props.returnFocusTo} />;
}
