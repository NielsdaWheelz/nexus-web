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

/** Account-scoped handoff survives its form; a departed account receives nothing. */
export async function openAsyncResult({
  ctx, originPaneId, intent, disposition, subject, create, mayOpen, beforeOpen, onDefault, initiatingLayer,
}: {
  ctx: Pick<ActionContext, "workspace" | "sessionSignal" | "feedback">;
  originPaneId?: string;
  intent: OpenIntent;
  disposition: "Follow" | "Adopt" | "Fork";
  subject?: string;
  create: () => Promise<OpenResult | null>;
  mayOpen?: () => boolean;
  beforeOpen?: () => void;
  onDefault?: (result: OpenResult) => void;
  /** A closed launcher may admit its already-known layer after dispatch. */
  initiatingLayer?: Layer | null;
}): Promise<void> {
  const origin = ctx.workspace();
  const paneId = originPaneId ?? origin.state.active_primary_pane_id;
  const visitId = origin.state.panes.find(pane => pane.id === paneId)?.current_visit.id;
  const generation = origin.foregroundGeneration;
  const overlayGeneration = getInteractionGeneration();
  const layer = getInteractionOwner();
  const continuingOwner = layer?.options.current.kind === "transient" ? getInteractionOwnerBelow(layer) : layer;
  const signal = ctx.sessionSignal();
  if (signal.aborted) return;
  let relinquished = false;
  const subsequentInput = (event: Event) => {
    if (isNavigationAttention(event)) relinquished = true;
  };
  for (const event of NAVIGATION_ATTENTION_EVENTS) window.addEventListener(event, subsequentInput, { capture: true, passive: true, signal });
  try {
    const result = await create();
    if (result === null || signal.aborted) return;
    const workspace = ctx.workspace();
    const owner = getInteractionOwner();
    const overlayUnchanged = overlayGeneration === getInteractionGeneration();
    const initiatingAdmission = layer === null && initiatingLayer != null && owner === initiatingLayer &&
      getInteractionGeneration() === overlayGeneration + 1;
    if (!relinquished && visitId !== undefined &&
      workspace.state.active_primary_pane_id === paneId &&
      workspace.state.panes.find(pane => pane.id === paneId)?.current_visit.id === visitId &&
      generation === workspace.foregroundGeneration &&
      ((overlayUnchanged && (owner === layer || owner === continuingOwner)) || initiatingAdmission) && (mayOpen?.() ?? true)) {
      beforeOpen?.();
      if (intent === "default" && onDefault) onDefault(result);
      else workspace.activateWorkspaceTarget({
        originPaneId: paneId, target: result.target, entry: result.entry,
        disposition: { kind: intent === "new_pane" ? "Fork" : disposition },
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
          const activateTarget = (request: Parameters<typeof current.activateWorkspaceTarget>[0]) =>
            current.activateWorkspaceTarget(request);
          const handled = activateTargetLink({
            event,
            runtime: { activateTarget: request => activateTarget({ ...request, originPaneId }) },
            target: result.target,
            entry: result.entry,
            onDefault: () => activateTarget({
              originPaneId, target: result.target, entry: result.entry, disposition: { kind: disposition },
            }),
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
  } finally {
    for (const event of NAVIGATION_ATTENTION_EVENTS) window.removeEventListener(event, subsequentInput, true);
  }
}
