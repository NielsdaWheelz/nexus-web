import {
  resolvePaneRouteModel,
  type ResolvedPaneRouteModel,
} from "@/lib/panes/paneRouteModel";
import {
  resolvePaneResourceLocator,
  type PaneResourceLocator,
} from "@/lib/panes/paneResourceLocator";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

export interface PaneRouteIdentity {
  href: string;
  routeId: ResolvedPaneRouteModel["id"];
  routeKey: string;
  resourceLocator: PaneResourceLocator | null;
}

export function resolvePaneRouteIdentity(href: string): PaneRouteIdentity {
  const normalizedHref = normalizeWorkspaceHref(href) ?? "/";
  const route = resolvePaneRouteModel(normalizedHref);
  const resourceLocator = resolvePaneResourceLocator(route);
  return {
    href: normalizedHref,
    routeId: route.id,
    routeKey: `${route.id}:${normalizedHref}`,
    resourceLocator,
  };
}

export function hasSamePaneRoute(leftHref: string, rightHref: string): boolean {
  return (
    resolvePaneRouteIdentity(leftHref).routeKey ===
    resolvePaneRouteIdentity(rightHref).routeKey
  );
}
