// A delayed result may land only while its initiating task still owns attention.
// Mutation identity, retry and mounted form state remain with the feature owner.
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import { truncateText } from "@/lib/display/format";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";
import { getInteractionGeneration, getInteractionOwner, getInteractionOwnerBelow, type Layer } from "@/lib/ui/overlay";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import type { WorkspacePaneEntry, WorkspaceTarget } from "@/lib/workspace/targetActivation";

export interface OpenResult {
  readonly target: WorkspaceTarget;
  readonly title: string;
  readonly openLabel: string;
  readonly entry?: WorkspacePaneEntry;
}

/** Read without reclaiming attention; account departure admits no feedback. */
export async function readForNavigation<T>({
  ctx, originPaneId, initiatingLayer, read,
}: {
  ctx: Pick<ActionContext, "workspace" | "sessionSignal">;
  originPaneId: string;
  initiatingLayer: Layer | null;
  read: () => Promise<T>;
}): Promise<{ kind: "Aborted" } | { kind: "Ready"; value: T; mayOpen: boolean }> {
  const origin = ctx.workspace();
  const visitId = origin.state.panes.find(pane => pane.id === originPaneId)?.current_visit.id;
  const generation = origin.foregroundGeneration;
  const overlayGeneration = getInteractionGeneration();
  const layer = getInteractionOwner();
  const continuingOwner = layer?.options.current.kind === "transient" ? getInteractionOwnerBelow(layer) : layer;
  const signal = ctx.sessionSignal();
  if (signal.aborted) return { kind: "Aborted" };
  let relinquished = false;
  const subsequentInput = (event: Event) => {
    if (isNavigationAttention(event)) relinquished = true;
  };
  for (const event of NAVIGATION_ATTENTION_EVENTS) window.addEventListener(event, subsequentInput, { capture: true, passive: true, signal });
  try {
    const value = await read();
    if (signal.aborted) return { kind: "Aborted" };
    const workspace = ctx.workspace();
    const owner = getInteractionOwner();
    const overlayUnchanged = overlayGeneration === getInteractionGeneration();
    const initiatingAdmission = layer === null && initiatingLayer != null && owner === initiatingLayer &&
      getInteractionGeneration() === overlayGeneration + 1;
    const mayOpen = !relinquished && visitId !== undefined &&
      workspace.state.active_primary_pane_id === originPaneId &&
      workspace.state.panes.find(pane => pane.id === originPaneId)?.current_visit.id === visitId &&
      generation === workspace.foregroundGeneration &&
      ((overlayUnchanged && (owner === layer || owner === continuingOwner)) || initiatingAdmission);
    return { kind: "Ready", value, mayOpen };
  } finally {
    for (const event of NAVIGATION_ATTENTION_EVENTS) window.removeEventListener(event, subsequentInput, true);
  }
}

/** Account-scoped handoff; the caller retains mutation and retry ownership. */
export async function openAsyncResult({
  ctx, originPaneId, intent, disposition = "Follow", originHistory, subject, create, mayOpen, beforeOpen, onDefault, initiatingLayer,
}: {
  ctx: Pick<ActionContext, "workspace" | "sessionSignal" | "feedback">;
  originPaneId?: string;
  intent: OpenIntent;
  /** Reader handoffs keep their origin and fork even when an offer is opened later. */
  disposition?: "Follow" | "Fork";
  originHistory?: "replace";
  subject?: string;
  create: () => Promise<OpenResult | null>;
  mayOpen?: () => boolean;
  beforeOpen?: () => void;
  /** Same-source inspection or materialisation of an already-placed view. */
  onDefault?: (result: OpenResult) => void;
  /** A closed launcher may admit its already-known layer after dispatch. */
  initiatingLayer?: Layer | null;
}): Promise<void> {
  const paneId = originPaneId ?? ctx.workspace().state.active_primary_pane_id;
  const signal = ctx.sessionSignal();
  const ready = await readForNavigation({ ctx, originPaneId: paneId, initiatingLayer: initiatingLayer ?? null, read: create });
  if (ready.kind === "Aborted" || ready.value === null) return;
  const result = ready.value;
  if (ready.mayOpen && (mayOpen?.() ?? true)) {
    beforeOpen?.();
    if (intent === "default" && onDefault) {
      onDefault(result);
      return;
    }
    ctx.workspace().activateWorkspaceTarget({
      originPaneId: paneId, target: result.target, entry: result.entry,
      disposition: { kind: intent === "new_pane" ? "Fork" : disposition },
      originHistory,
    });
    return;
  }
  const label = subject ?? result.target.labelHint;
  const shownLabel = label === undefined ? undefined : truncateText(label, 120);
  const offer = ctx.feedback.offer({
    key: `open-result:${result.target.href}`,
    content: {
      tone: "Success", title: shownLabel ? `${result.title} · ${shownLabel}` : result.title,
      message: label !== shownLabel ? label : undefined,
    },
    announcement: "Polite",
    actions: [{
      label: result.openLabel,
      href: result.target.href,
      onActivate: event => {
        if (signal.aborted) { event.preventDefault(); return "consumed"; }
        const current = ctx.workspace();
        const originPaneId = current.state.active_primary_pane_id;
        const handled = activateTargetLink({
          event,
          runtime: { activateTarget: request => current.activateWorkspaceTarget({
            ...request, originPaneId,
            disposition: { kind: request.disposition.kind === "Fork" ? "Fork" : disposition },
          }) },
          target: result.target,
          entry: result.entry,
        });
        if (handled === "handled-default" || handled === "handled-new-pane") offer.withdraw();
        return handled;
      },
    }],
    returnFocus: () => {
      if (signal.aborted) return null;
      const active = ctx.workspace().state.active_primary_pane_id;
      return findPaneChromeFocusTarget(active) ?? findPaneLandmarkFocusTarget(active);
    },
  });
}
