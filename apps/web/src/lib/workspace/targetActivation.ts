import { hasSamePaneRoute } from "@/lib/panes/paneIdentity";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

export interface WorkspaceTarget {
  href: string;
  labelHint?: string;
  secondaryActivation?: WorkspaceSecondaryActivation;
}

export type WorkspaceTargetDisposition =
  | { kind: "Follow" }
  | { kind: "Fork" }
  | { kind: "Adopt" };

export interface WorkspaceTargetActivationRequest {
  originPaneId: string;
  target: WorkspaceTarget;
  disposition: WorkspaceTargetDisposition;
  modality: PaneNavigationModality;
}

export type WorkspaceTargetActivationResult =
  | {
      kind:
        | "Unchanged"
        | "NavigatedOrigin"
        | "ActivatedExisting"
        | "NavigatedExisting"
        | "CreatedPane";
      paneId: string;
    }
  | { kind: "Rejected"; reason: "PaneLimitReached" };

export type WorkspaceTargetActivationPlan =
  | { kind: "Unchanged"; paneId: string }
  | { kind: "NavigateOrigin"; paneId: string; href: string }
  | { kind: "ActivateExisting"; paneId: string }
  | { kind: "NavigateExisting"; paneId: string; href: string }
  | { kind: "CreateAfterOrigin"; originPaneId: string; target: WorkspaceTarget }
  | { kind: "Reject"; reason: "PaneLimitReached" };

export interface WorkspaceTargetActivationPane {
  paneId: string;
  href: string;
  minimized: boolean;
}

export interface WorkspaceTargetActivationPlannerInput {
  originPaneId: string;
  target: WorkspaceTarget;
  disposition: WorkspaceTargetDisposition;
  panes: readonly WorkspaceTargetActivationPane[];
  maxPanes: number;
}

function requireSupportedTarget(target: WorkspaceTarget): WorkspaceTarget {
  const href = normalizeWorkspaceHref(target.href);
  if (!href || resolvePaneRoute(href).id === "unsupported") {
    // justify-defect: this in-process capability accepts only targets already
    // validated by its caller-side adapter or named workflow.
    throw new Error(`Unsupported workspace target: ${target.href}`);
  }
  return { ...target, href };
}

function selectExactPane(
  panes: readonly WorkspaceTargetActivationPane[],
  originPaneId: string,
  href: string,
): WorkspaceTargetActivationPane | null {
  const matches = panes.filter((pane) => hasSamePaneRoute(pane.href, href));
  return (
    matches.find((pane) => pane.paneId === originPaneId) ??
    matches.find((pane) => !pane.minimized) ??
    matches[0] ??
    null
  );
}

export function planWorkspaceTargetActivation(
  input: WorkspaceTargetActivationPlannerInput,
): WorkspaceTargetActivationPlan {
  const target = requireSupportedTarget(input.target);
  const origin = input.panes.find((pane) => pane.paneId === input.originPaneId);
  if (!origin) {
    // justify-defect: a pane runtime always binds an extant workspace pane.
    throw new Error(`Unknown workspace origin pane: ${input.originPaneId}`);
  }

  const create = (): WorkspaceTargetActivationPlan =>
    input.panes.length >= input.maxPanes
      ? { kind: "Reject", reason: "PaneLimitReached" }
      : {
          kind: "CreateAfterOrigin",
          originPaneId: input.originPaneId,
          target,
        };

  const exactPane = selectExactPane(input.panes, input.originPaneId, target.href);
  switch (input.disposition.kind) {
    case "Fork":
      return create();

    case "Follow":
      if (!exactPane) {
        return { kind: "NavigateOrigin", paneId: origin.paneId, href: target.href };
      }
      if (exactPane.href === target.href) {
        return exactPane.paneId === origin.paneId
          ? { kind: "Unchanged", paneId: exactPane.paneId }
          : { kind: "ActivateExisting", paneId: exactPane.paneId };
      }
      return {
        kind: "NavigateExisting",
        paneId: exactPane.paneId,
        href: target.href,
      };

    case "Adopt":
      if (!exactPane) {
        return create();
      }
      if (exactPane.href === target.href) {
        return exactPane.paneId === origin.paneId
          ? { kind: "Unchanged", paneId: exactPane.paneId }
          : { kind: "ActivateExisting", paneId: exactPane.paneId };
      }
      return {
        kind: "NavigateExisting",
        paneId: exactPane.paneId,
        href: target.href,
      };
  }

  const exhaustiveDisposition: never = input.disposition;
  return exhaustiveDisposition;
}
