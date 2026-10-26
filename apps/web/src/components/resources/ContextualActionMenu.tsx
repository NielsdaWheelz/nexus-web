"use client";

import { useCallback, useState } from "react";
import type { ResourceActivation } from "@/lib/resources/activation";
import { ActionMenuHost, ActionMenuInvocation, type ActionMenuProps, type ActionMenuSession } from "@/components/ui/ActionMenu";
import type { PodcastActionFocus } from "@/lib/actions/inlineActions";
import { AUTHORED_ACTION_IDS, useAuthoredActions } from "@/lib/actions/useAuthoredActions";
import { useClientActions, useResourceActions } from "@/lib/actions/useResourceActions";
import { usePaneSubject } from "@/lib/panes/paneChrome";
import { useTouchCapable } from "@/lib/renderEnvironment/provider";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor, MenuContent, MenuOption, MenuSource, TrailingState } from "@/lib/ui/actionDescriptor";

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly MenuOption[];
}

/**
 * One composer for a place and its resource principal. Publishes local pane,
 * occurrence or view choices and authoritative resource verbs as one complete
 * result; an optional source label names that principal. A supplied disabled
 * reason blocks commands. An owned authored principal publishes its local verbs as
 * soon as one local read settles; the server's verbs for it settle separately in the
 * menu's trailing region (loading, ready or failed), never gating, reordering or
 * replacing the local snapshot.
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
    <ContextualMenuInvocation {...props} subjectKey={subjectKey} session={session} />
  }</ActionMenuHost>;
}

/** Authoritative facts and client subscriptions belong only to an invocation. */
function ContextualMenuInvocation({
  sections, resourceRef, title, subjectKey, onDefect, actionFocus,
  omitResourceActions = [], showSourceSubject = false, displayedActivation, commandDisabledReason, session, ...props
}: ContextualMenuProps & { readonly session: ActionMenuSession }) {
  const pane = usePaneRuntime();
  const paneSubject = usePaneSubject();
  const coarse=useTouchCapable();
  const resource = useResourceActions(resourceRef ?? null, onDefect, actionFocus);
  const state = resource.state;
  const client = useClientActions(resourceRef ?? null, title);
  const authored = useAuthoredActions(resourceRef ?? null, title);
  const [request, setRequest] = useState<AbortSignal | null>(null);
  const prepareAuthored = authored.prepare, prepareRemote = resource.prepare;
  const prepare = useCallback((signal: AbortSignal) => {
    setRequest(signal);
    prepareAuthored(signal);
    prepareRemote(signal);
  }, [prepareAuthored, prepareRemote]);
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
  // An owned authored resource publishes its local verbs once the local read settles; the
  // server's facts settle separately in the trailing region and cannot gate them.
  const local = request !== null && authored.read?.request === request ? authored.read : null;
  // A caller that omits every local verb gets the server-backed menu, whose copies it omits too.
  const verbs = local?.actions.filter((action) => !omitResourceActions.includes(action.id)) ?? [];
  const owned = local !== null && verbs.length > 0;
  const remote = state !== null && state.request === request ? state : null;
  if (owned) {
    groups.push({ id: "Resource", label: "item", options: verbs });
  } else {
    if (remote?.kind === "Ready") {
      const options = remote.options.filter((action) => !omitResourceActions.includes(action.id) && !((displayedActivation || resourceRef === paneSubject) && ["Open", "OpenInNewPane"].includes(action.id)));
      if (options.length > 0) groups.push({
        id: "Resource", label: showSourceSubject ? `source: ${remote.facts.label}` : "item", options,
      });
    }
    if (remote?.kind === "Failed" && remote.connectionRequired) groups.push({
      id: "Resource", label: null, options: [{ kind: "command", id: "Resource.ConnectionRequired", label: "requires a connection", disabled: true, onSelect: () => {} }],
    });
  }
  // Client-owned facts compose beside the remote facts; a remote verb with the same id wins.
  // A published local snapshot cannot depend on server facts that settle after it.
  const remoteIds = new Set(!owned && remote?.kind === "Ready" ? remote.options.map(action => action.id) : []);
  const device = client.filter(action => !remoteIds.has(action.id) && !omitResourceActions.includes(action.id));
  if (device.length > 0) groups.push({ id: "Device", label: "on this device", options: device });
  const blocked = (action: MenuOption): MenuOption => commandDisabledReason && action.kind === "command"
    ? { ...action, disabled: true, disabledReason: commandDisabledReason } : action;
  const blockedRemote = (action: ActionDescriptor): ActionDescriptor => commandDisabledReason && action.kind === "command"
    ? { ...action, disabled: true, disabledReason: commandDisabledReason } : action;
  const content: MenuContent = { sections: groups.map((section) => ({
    ...section,
    label: groups.length > 1 || (showSourceSubject && section.id === "Resource") ? section.label : null,
    options: section.options.map(blocked),
  })) };
  const identity = { title, subjectKey };
  const trailing: TrailingState = request === null ? null : remote?.kind === "Ready" ? {
    kind: "Ready", request, label: showSourceSubject ? `source: ${remote.facts.label}` : null,
    options: remote.options.filter((action) => !omitResourceActions.includes(action.id) &&
      !((displayedActivation || resourceRef === paneSubject) && ["Open", "OpenInNewPane"].includes(action.id)) && !AUTHORED_ACTION_IDS.has(action.id)).map(blockedRemote),
  } : remote?.kind === "Failed" ? {
    kind: "Failed", request, feedback: remote.connectionRequired ? { tone: "Neutral", title: "requires a connection" } : remote.feedback,
  } : { kind: "Loading", request };
  const source: MenuSource = !resourceRef ? { ...identity, kind: "Immediate", content }
    : owned && local !== null ? { ...identity, kind: "Prepared", prepare, state: { kind: "Ready", request: local.request, content }, trailing }
    : {
      ...identity, kind: "Prepared", prepare,
      state: request === null ? null : local === null ? { kind: "Loading", request }
        : remote?.kind === "Ready" || remote?.kind === "Failed" && remote.connectionRequired ? { kind: "Ready", request, content } : remote,
    };
  return <ActionMenuInvocation source={source} session={session} placement={props.placement} align={props.align} returnFocusTo={props.returnFocusTo} />;
}
