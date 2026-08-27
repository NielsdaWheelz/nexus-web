import {
  resolvePaneRouteModel,
  type ResolvedPaneRouteModel,
} from "@/lib/panes/paneRouteModel";
import {
  paneResourceLocatorKey,
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

export type WorkspaceActivationRouteId = string & {
  readonly __workspaceActivationRouteId: unique symbol;
};

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

export function resolveWorkspaceActivationRouteId(
  href: string,
): WorkspaceActivationRouteId {
  const identity = resolvePaneRouteIdentity(href);
  const ownerKey = paneResourceLocatorKey(identity.resourceLocator);
  // justify-type-assertion: this owner is the sole constructor for the opaque
  // activation-route identity.
  return (
    ownerKey ? `${identity.routeId}:${ownerKey}` : identity.routeKey
  ) as WorkspaceActivationRouteId;
}

export function hasSamePaneResource(
  leftHref: string,
  rightHref: string,
): boolean {
  const leftKey = paneResourceLocatorKey(
    resolvePaneRouteIdentity(leftHref).resourceLocator,
  );
  return (
    leftKey !== null &&
    leftKey ===
      paneResourceLocatorKey(
        resolvePaneRouteIdentity(rightHref).resourceLocator,
      )
  );
}
