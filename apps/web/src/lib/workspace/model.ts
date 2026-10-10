// The workspace state and the rules the server entry and the client store
// share. The shape is the api's (python validates every save and stored read),
// so the web has no decoder: a stored row python cannot read arrives as null.
import type { Schema } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { WORKSPACE_DEFAULT_FALLBACK_HREF } from "@/lib/workspace/workspaceHref";

// FastAPI names the response half of a body-and-response model `-Output`.
export type WorkspaceState = Schema<"WorkspaceState-Output">;
export type WorkspacePane = Schema<"WorkspacePane-Output">;
export type WorkspaceSecondaryPane = Schema<"WorkspaceSecondaryPane">;
export type PaneVisit = Schema<"PaneVisit">;
export interface ClosedPane {
  pane: WorkspacePane;
  index: number;
}

export const MAX_PANES = 12;

export function newVisit(href: string): PaneVisit {
  return { id: crypto.randomUUID(), href };
}

/** A visible pane with no history; a null width follows the reader column. */
export function newPane(href: string): WorkspacePane {
  return {
    id: createRandomId("pane"),
    currentVisit: newVisit(href),
    primaryWidthPx: null,
    visibility: "visible",
    history: { back: [], forward: [] },
    secondary: null,
  };
}

/**
 * Moves a pane to `visit`. Width and Inspector survive only a move within one
 * resource (for a route naming none, within one route and path), and the
 * Inspector only while the new route still offers its group.
 */
export function moveTo(
  pane: WorkspacePane,
  visit: PaneVisit,
  keepLayout = sameLayout(pane.currentVisit.href, visit.href),
): WorkspacePane {
  const secondary = keepLayout ? pane.secondary : null;
  const groups = resolvePaneRouteModel(visit.href).groups;
  return {
    ...pane,
    currentVisit: visit,
    primaryWidthPx: keepLayout ? pane.primaryWidthPx : null,
    secondary: secondary && groups.includes(secondary.groupId) ? secondary : null,
  };
}

function sameLayout(left: string, right: string): boolean {
  const a = resolvePaneRouteModel(left);
  const b = resolvePaneRouteModel(right);
  if (a.resourceKey) return a.resourceKey === b.resourceKey;
  return a.id === b.id && a.pathname === b.pathname;
}

function isNonTrivial({ panes }: WorkspaceState): boolean {
  const [pane] = panes;
  return (
    panes.length > 1 ||
    pane!.currentVisit.href !== WORKSPACE_DEFAULT_FALLBACK_HREF ||
    pane!.secondary !== null ||
    pane!.history.back.length + pane!.history.forward.length > 0
  );
}

/**
 * Entry: this device's session if worth resuming, else the newest one saved
 * elsewhere, else one default pane. A deep link `href` then reuses the pane on
 * its route or resource, or is appended (keeping the newest 11 at the cap).
 */
export function enterWorkspace(
  own: WorkspaceState | null,
  elsewhere: WorkspaceState | null,
  href: string | null,
): WorkspaceState {
  const restored = [own, elsewhere].find((s) => s !== null && isNonTrivial(s));
  if (!restored) {
    const pane = newPane(href ?? WORKSPACE_DEFAULT_FALLBACK_HREF);
    return { activePrimaryPaneId: pane.id, panes: [pane] };
  }
  if (href === null) return restored;
  const target = resolvePaneRouteModel(href);
  const existing = restored.panes.find((pane) => {
    const route = resolvePaneRouteModel(pane.currentVisit.href);
    return (
      route.routeKey === target.routeKey ||
      (route.resourceKey !== null && route.resourceKey === target.resourceKey)
    );
  });
  if (!existing) {
    const pane = newPane(href);
    const kept = restored.panes.slice(1 - MAX_PANES);
    return { activePrimaryPaneId: pane.id, panes: [...kept, pane] };
  }
  const visit = { id: existing.currentVisit.id, href };
  return {
    activePrimaryPaneId: existing.id,
    panes: restored.panes.map((pane) =>
      pane === existing
        ? { ...moveTo(pane, visit, true), visibility: "visible" }
        : pane,
    ),
  };
}
