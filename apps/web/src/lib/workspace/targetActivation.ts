// Where a link lands: one pure planner over the open panes. The store
// executes the plan; callers never choose or create panes themselves.
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import { MAX_PANES, type WorkspaceState } from "@/lib/workspace/model";
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

export interface WorkspacePaneEntry {
  kind: "AppendNote";
  noteId: string;
  clientMutationId: string;
  initialText: string;
}

export interface WorkspaceTargetActivationRequest {
  originPaneId: string;
  target: WorkspaceTarget;
  disposition: WorkspaceTargetDisposition;
  /** Daily Today/quick note: hand `entry` to the exact visit the target lands on. */
  paneEntryActivation?: {
    activationId: string;
    entry: WorkspacePaneEntry | null;
  };
}

export interface PaneEntryDelivery {
  activationId: string;
  paneId: string;
  visitId: string;
  entry: WorkspacePaneEntry;
}

/** A daily page pane's identity, published by its body (under either href). */
export interface PaneDailyPage {
  localDate: string;
  pageId: string | null;
}

type Landed =
  | "Unchanged"
  | "ActivatedExisting"
  | "NavigatedOrigin"
  | "NavigatedExisting"
  | "CreatedPane";
export type WorkspaceTargetActivationResult =
  | { kind: Landed; paneId: string }
  | { kind: "Rejected"; reason: "PaneLimitReached" };
/** CreatedPane names the origin; the store mints the new pane after it. */
export type WorkspaceTargetPlan =
  | { kind: Landed; paneId: string; href: string }
  | { kind: "Rejected"; reason: "PaneLimitReached" };

/**
 * An open pane matches on route plus query (never hash), or as the same daily
 * page under its other href. Preference: origin, first visible, first. Fork
 * always creates; without a match Follow navigates the origin and Adopt
 * creates. Creation at the cap is rejected, never evicts.
 */
export function planWorkspaceTarget(
  state: WorkspaceState,
  dailyPages: ReadonlyMap<string, { routeKey: string; value: PaneDailyPage }>,
  request: WorkspaceTargetActivationRequest,
): WorkspaceTargetPlan {
  const href = normalizeWorkspaceHref(request.target.href);
  const origin = state.panes.find((pane) => pane.id === request.originPaneId);
  if (!href || !origin) {
    // justify-defect: callers pass same-origin hrefs from a live pane.
    throw new Error(`Invalid workspace target: ${request.target.href}`);
  }
  const target = resolvePaneRouteModel(href);
  const sameDay = (paneId: string, route: { id: string; routeKey: string }) => {
    const daily = dailyPages.get(paneId);
    if (route.id === target.id || daily?.routeKey !== route.routeKey) return false;
    return target.id === "dailyDate"
      ? daily.value.localDate === target.params.localDate
      : target.id === "page" && daily.value.pageId === target.params.pageId;
  };
  const matches = state.panes.flatMap((pane) => {
    const route = resolvePaneRouteModel(pane.currentVisit.href);
    if (route.routeKey === target.routeKey) return [{ pane, exact: false }];
    return sameDay(pane.id, route) ? [{ pane, exact: true }] : [];
  });
  const match =
    matches.find((m) => m.pane === origin) ??
    matches.find((m) => m.pane.visibility === "visible") ??
    matches[0];
  const create: WorkspaceTargetPlan =
    state.panes.length >= MAX_PANES
      ? { kind: "Rejected", reason: "PaneLimitReached" }
      : { kind: "CreatedPane", paneId: origin.id, href };
  if (request.disposition.kind === "Fork") return create;
  if (!match) {
    return request.disposition.kind === "Follow"
      ? { kind: "NavigatedOrigin", paneId: origin.id, href }
      : create;
  }
  const { pane } = match;
  if (!match.exact && pane.currentVisit.href !== href) {
    return { kind: "NavigatedExisting", paneId: pane.id, href };
  }
  const kind = pane === origin ? "Unchanged" : "ActivatedExisting";
  return { kind, paneId: pane.id, href };
}
