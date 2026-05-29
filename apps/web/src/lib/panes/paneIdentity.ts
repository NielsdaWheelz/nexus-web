import {
  resolvePaneRouteModel,
  type ResolvedPaneRouteModel,
} from "@/lib/panes/paneRouteModel";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

export interface PaneRouteIdentity {
  href: string;
  routeId: ResolvedPaneRouteModel["id"];
  resourceRef: string | null;
  resourceKey: string;
}

export function resolvePaneRouteIdentity(href: string): PaneRouteIdentity {
  const normalizedHref = normalizeWorkspaceHref(href) ?? "/";
  const route = resolvePaneRouteModel(normalizedHref);
  return {
    href: normalizedHref,
    routeId: route.id,
    resourceRef: route.resourceRef,
    resourceKey: route.resourceRef
      ? `${route.id}:${route.resourceRef}`
      : `${route.id}:${normalizedHref}`,
  };
}

export function hasSamePaneResource(leftHref: string, rightHref: string): boolean {
  return (
    resolvePaneRouteIdentity(leftHref).resourceKey ===
    resolvePaneRouteIdentity(rightHref).resourceKey
  );
}
