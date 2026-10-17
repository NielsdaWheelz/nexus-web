// The workspace state and the rules the server entry and the client store
// share. The shape is the api's (python validates every save and stored read),
// so the web has no decoder. Only a missing row is null; invalid saved state
// fails the read before a client store can mount and autosave a replacement.
import type { Schema } from "@/lib/api/wire";
import { collapseWhitespace } from "@/lib/collapseWhitespace";
import { createRandomId } from "@/lib/createRandomId";
import { resolvePaneRouteModel, resolveWorkspaceActivationRouteId } from "@/lib/panes/paneRouteModel";
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

export function normalizeVisitTitleHint(title: string | null | undefined): string | null {
  const text = title ? collapseWhitespace(title) : "";
  const points = Array.from(text);
  return points.length > 512 ? `${points.slice(0, 511).join("")}…` : text || null;
}

export function newVisit(href: string, titleHint?: string | null): PaneVisit {
  return {
    id: crypto.randomUUID(),
    href,
    title_hint: resolvePaneRouteModel(href).titleKey ? normalizeVisitTitleHint(titleHint) : null,
  };
}

/** A view replacement keeps identity evidence only for the same destination. */
export function replaceVisit(visit: PaneVisit, href: string, titleHint?: string): PaneVisit {
  const key = resolvePaneRouteModel(href).titleKey;
  const same = key !== null && key === resolvePaneRouteModel(visit.href).titleKey;
  return {
    id: visit.id,
    href,
    title_hint: key === null ? null : titleHint === undefined
      ? same ? visit.title_hint : null
      : normalizeVisitTitleHint(titleHint),
  };
}

/** A visible pane with no history; a null width follows the reader column. */
export function newPane(href: string, titleHint?: string): WorkspacePane {
  return {
    id: createRandomId("pane"),
    current_visit: newVisit(href, titleHint),
    primary_width_px: null,
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
  keepLayout = sameLayout(pane.current_visit.href, visit.href),
): WorkspacePane {
  const secondary = keepLayout ? pane.secondary : null;
  const groups = resolvePaneRouteModel(visit.href).groups;
  return {
    ...pane,
    current_visit: visit,
    primary_width_px: keepLayout ? pane.primary_width_px : null,
    secondary: secondary && groups.includes(secondary.group_id) ? secondary : null,
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
    pane!.current_visit.href !== WORKSPACE_DEFAULT_FALLBACK_HREF ||
    pane!.secondary !== null ||
    pane!.history.back.length + pane!.history.forward.length > 0
  );
}

/**
 * Entry: this device's session if worth resuming, else the newest one saved
 * elsewhere, else one default pane. A deep link `href` then reuses the pane on
 * its resource and view, or is appended without removing existing panes.
 */
export function enterWorkspace(
  own: WorkspaceState | null,
  elsewhere: WorkspaceState | null,
  href: string | null,
): WorkspaceState {
  const restored = [own, elsewhere].find((s) => s !== null && isNonTrivial(s));
  if (!restored) {
    const pane = newPane(href ?? WORKSPACE_DEFAULT_FALLBACK_HREF);
    return { active_primary_pane_id: pane.id, panes: [pane] };
  }
  if (href === null) return restored;
  const target = resolveWorkspaceActivationRouteId(href);
  const existing = restored.panes.find((pane) =>
    resolveWorkspaceActivationRouteId(pane.current_visit.href) === target,
  );
  if (!existing) {
    const pane = newPane(href);
    return { active_primary_pane_id: pane.id, panes: [...restored.panes, pane] };
  }
  const visit = replaceVisit(existing.current_visit, href);
  return {
    active_primary_pane_id: existing.id,
    panes: restored.panes.map((pane) =>
      pane === existing
        ? { ...moveTo(pane, visit, true), visibility: "visible" }
        : pane,
    ),
  };
}
