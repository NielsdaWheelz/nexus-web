import { hasSamePaneRoute } from "@/lib/panes/paneIdentity";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

export interface WorkspaceTarget {
  href: string;
  labelHint?: string;
  secondaryActivation?: WorkspaceSecondaryActivation;
  aliases?: readonly string[];
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
  paneEntryActivation?: WorkspacePaneEntryActivation;
}

export interface WorkspacePaneEntry {
  kind: "AppendNote";
  noteId: string;
  clientMutationId: string;
  initialText: string;
}

export interface WorkspacePaneEntryActivation {
  activationId: string;
  entry: WorkspacePaneEntry | null;
}

export interface PaneEntryDelivery {
  activationId: string;
  paneId: string;
  visitId: string;
  entry: WorkspacePaneEntry;
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
  aliases?: readonly string[];
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

function canonicalRouteAliases(
  route: ReturnType<typeof resolvePaneRoute>,
): readonly string[] {
  if (route.id === "dailyDate" && route.params.localDate) {
    return [`daily:${route.params.localDate}`];
  }
  if (route.id === "page" && route.params.pageId) {
    return [`page:${route.params.pageId}`];
  }
  return [];
}

function selectMatchingPane(
  panes: readonly WorkspaceTargetActivationPane[],
  originPaneId: string,
  target: WorkspaceTarget,
): { pane: WorkspaceTargetActivationPane; kind: "Route" | "Alias" } | null {
  const targetRoute = resolvePaneRoute(target.href);
  const targetAliases = new Set([
    ...canonicalRouteAliases(targetRoute),
    ...(target.aliases ?? []),
  ]);
  const matches = panes
    .map((pane) => {
      const paneRoute = resolvePaneRoute(pane.href);
      const isAlias =
        paneRoute.id !== targetRoute.id &&
        [...canonicalRouteAliases(paneRoute), ...(pane.aliases ?? [])].some(
          (alias) => targetAliases.has(alias),
        );
      return {
        pane,
        kind: hasSamePaneRoute(pane.href, target.href)
          ? ("Route" as const)
          : isAlias
            ? ("Alias" as const)
            : null,
      };
    })
    .filter(
      (
        match,
      ): match is {
        pane: WorkspaceTargetActivationPane;
        kind: "Route" | "Alias";
      } => match.kind !== null,
    );
  return (
    matches.find((match) => match.pane.paneId === originPaneId) ??
    matches.find((match) => !match.pane.minimized) ??
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

  const match = selectMatchingPane(input.panes, input.originPaneId, target);
  const exactPane = match?.pane ?? null;
  switch (input.disposition.kind) {
    case "Fork":
      return create();

    case "Follow":
      if (!exactPane) {
        return { kind: "NavigateOrigin", paneId: origin.paneId, href: target.href };
      }
      if (match?.kind === "Alias") {
        return exactPane.paneId === origin.paneId
          ? { kind: "Unchanged", paneId: exactPane.paneId }
          : { kind: "ActivateExisting", paneId: exactPane.paneId };
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
      if (match?.kind === "Alias") {
        return exactPane.paneId === origin.paneId
          ? { kind: "Unchanged", paneId: exactPane.paneId }
          : { kind: "ActivateExisting", paneId: exactPane.paneId };
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
