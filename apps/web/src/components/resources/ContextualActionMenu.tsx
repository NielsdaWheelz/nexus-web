"use client";

import { useEffect, useState, type ComponentProps } from "react";
import type { ResourceActivation } from "@/lib/resources/activation";
import ActionMenu from "@/components/ui/ActionMenu";
import type { PodcastActionFocus } from "@/lib/actions/inlineActions";
import { ACTION_CATALOG, type ActionId } from "@/lib/actions/catalog";
import { AUTHORED_ACTION_IDS, useAuthoredActions } from "@/lib/actions/useAuthoredActions";
import { useClientActions, useResourceActions } from "@/lib/actions/useResourceActions";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor, MenuContent, MenuSource } from "@/lib/ui/actionDescriptor";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;
const CATALOG_ORDER: readonly string[] = Object.keys(ACTION_CATALOG);

/** Catalog order is menu order; a separator starts each new catalog group. */
function inCatalogOrder(options: readonly ActionDescriptor[]): ActionDescriptor[] {
  const rank = (id: string) => { const index = CATALOG_ORDER.indexOf(id); return index < 0 ? CATALOG_ORDER.length : index; };
  let group: string | undefined;
  return [...options].sort((a, b) => rank(a.id) - rank(b.id)).map((option) => {
    const own = CATALOG_ORDER.includes(option.id) ? ACTION_CATALOG[option.id as ActionId].group : undefined;
    const separatorBefore = group !== undefined && own !== undefined && own !== group;
    group = own ?? group;
    return { ...option, separatorBefore: separatorBefore || undefined };
  });
}

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly ActionDescriptor[];
}

/**
 * One composer for a place and its resource principal. Publishes local pane,
 * occurrence or view choices and authoritative resource verbs as one complete
 * result; an optional source label names that principal. A supplied disabled
 * reason blocks commands. An owned authored principal's local verbs come from the
 * local store; a failed or unreachable server read presents them at once, with the
 * failure as one disabled line. A pending read still settles before publication,
 * because a published menu is a fixed snapshot.
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
  const client = useClientActions(resourceRef ?? null, title);
  const authoredActions = useAuthoredActions(resourceRef ?? null, title);
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
  // An owned authored resource's local verbs replace the server's copies; a failed server read never hides them.
  // Ownership is the local projection's, before any caller omission.
  const owned = authoredActions.length > 0;
  const authored = authoredActions.filter((action) => !omitResourceActions.includes(action.id));
  const remoteOptions = state?.kind === "Ready" ? state.options.filter((action) => !omitResourceActions.includes(action.id) &&
    !(displayedActivation && ["Open", "OpenInNewPane"].includes(action.id)) &&
    !(owned && AUTHORED_ACTION_IDS.has(action.id))) : [];
  const remoteUnavailable: ActionDescriptor[] = state?.kind === "Failed" && (state.connectionRequired || owned) ? [{
    kind: "command", id: state.connectionRequired ? "Resource.ConnectionRequired" : "Resource.Unavailable",
    label: state.connectionRequired ? "requires a connection" : state.feedback.title, disabled: true, onSelect: () => {},
    separatorBefore: authored.length > 0 || undefined,
  }] : [];
  const item = owned ? [...inCatalogOrder([...authored, ...remoteOptions]), ...remoteUnavailable] : [...remoteOptions, ...remoteUnavailable];
  if (item.length > 0) groups.push({
    id: "Resource", options: item,
    label: authored.length + remoteOptions.length === 0 ? null : showSourceSubject && state?.kind === "Ready" ? `source: ${state.facts.label}` : "item",
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
    state: state?.kind === "Ready" || state?.kind === "Failed" && (state.connectionRequired || owned)
      ? { kind: "Ready", request: state.request, content } : state,
  } : { ...identity, kind: "Immediate", content };
  return <ActionMenu {...props} label={props.label ?? `more actions for ${title}`} source={source} />;
}
