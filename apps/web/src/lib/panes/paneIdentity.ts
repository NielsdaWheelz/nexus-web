import {
  resolvePaneRoute,
  type ResolvedPaneRoute,
} from "@/lib/panes/paneRouteRegistry";
import { normalizeWorkspaceHref } from "@/lib/workspace/schema";

export interface PaneRouteIdentity {
  href: string;
  routeId: ResolvedPaneRoute["id"];
  resourceRef: string | null;
  resourceKey: string;
}

export function resolvePaneRouteIdentity(href: string): PaneRouteIdentity {
  const normalizedHref = normalizeWorkspaceHref(href) ?? "/";
  const route = resolvePaneRoute(normalizedHref);
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
