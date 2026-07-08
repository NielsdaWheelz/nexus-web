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

export function normalizePaneRouteKeyHref(href: string): string {
  const normalizedHref = normalizeWorkspaceHref(href) ?? "/";
  return normalizedHref.split("#", 1)[0] ?? normalizedHref;
}

export function resolvePaneRouteIdentity(href: string): PaneRouteIdentity {
  const normalizedHref = normalizeWorkspaceHref(href) ?? "/";
  const route = resolvePaneRouteModel(normalizedHref);
  const resourceLocator = resolvePaneResourceLocator(route);
  return {
    href: normalizedHref,
    routeId: route.id,
    routeKey: `${route.id}:${normalizePaneRouteKeyHref(normalizedHref)}`,
    resourceLocator,
  };
}

export function hasSamePaneRoute(leftHref: string, rightHref: string): boolean {
  return (
    resolvePaneRouteIdentity(leftHref).routeKey ===
    resolvePaneRouteIdentity(rightHref).routeKey
  );
}

export function paneResourceLocatorKey(locator: PaneResourceLocator | null): string | null {
  if (!locator) return null;
  switch (locator.kind) {
    case "resource_ref":
      return `resource_ref:${locator.ref}`;
    case "contributor_handle":
      return `contributor_handle:${locator.handle}`;
    default: {
      const _exhaustive: never = locator;
      return _exhaustive;
    }
  }
}

export function hasSamePaneResource(leftHref: string, rightHref: string): boolean {
  const leftKey = paneResourceLocatorKey(resolvePaneRouteIdentity(leftHref).resourceLocator);
  return (
    leftKey !== null &&
    leftKey === paneResourceLocatorKey(resolvePaneRouteIdentity(rightHref).resourceLocator)
  );
}
