import type { ResolvedPaneRouteModel } from "@/lib/panes/paneRouteModel";
import {
  formatResourceRef,
  parseResourceRef,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";
import {
  routeShareTarget,
} from "@/lib/sharing/targets";
import type { ShareTarget } from "@/lib/sharing/types";

export type PaneResourceLocator =
  | { kind: "resource_ref"; ref: string }
  | { kind: "contributor_handle"; handle: string };

export type PaneRouteShareIdentity = Extract<ShareTarget, { kind: "Route" }>;

function resourceRefLocator(
  scheme: ResourceScheme,
  id: string | undefined,
): PaneResourceLocator | null {
  if (!id) return null;
  const ref = formatResourceRef({ scheme, id });
  return parseResourceRef(ref) ? { kind: "resource_ref", ref } : null;
}

export function resolvePaneResourceLocator(
  route: Pick<ResolvedPaneRouteModel, "id" | "params">,
): PaneResourceLocator | null {
  if (route.id === "library") return resourceRefLocator("library", route.params.id);
  if (route.id === "media") return resourceRefLocator("media", route.params.id);
  if (route.id === "conversation") {
    return resourceRefLocator("conversation", route.params.id);
  }
  if (route.id === "podcastDetail") {
    return resourceRefLocator("podcast", route.params.podcastId);
  }
  if (route.id === "page") return resourceRefLocator("page", route.params.pageId);
  if (route.id === "note") {
    return resourceRefLocator("note_block", route.params.blockId);
  }
  if (route.id === "oracleReading") {
    return resourceRefLocator("oracle_reading", route.params.readingId);
  }
  if (route.id === "author") {
    const handle = route.params.handle?.trim();
    return handle ? { kind: "contributor_handle", handle } : null;
  }
  return null;
}

const INTERNAL_ROUTE_IDS = new Set([
  "conversationNew",
  "search",
  "settings",
  "settingsAccount",
  "settingsBilling",
  "settingsReader",
  "settingsAppearance",
  "settingsLocalVault",
  "settingsIdentities",
  "settingsKeybindings",
]);
const RESOURCE_ROUTE_IDS = new Set([
  "library",
  "media",
  "conversation",
  "podcastDetail",
  "page",
  "note",
  "oracleReading",
  "author",
]);

/**
 * Route-only Share identity. Resource panes publish their explicit decoded
 * action target through pane chrome; stable non-resource routes use the route
 * owner's canonical pathname.
 */
export function resolvePaneRouteShareIdentity(
  route: ResolvedPaneRouteModel,
  label: string,
): PaneRouteShareIdentity | null {
  if (route.id === "unsupported" || INTERNAL_ROUTE_IDS.has(route.id)) {
    return null;
  }
  if (RESOURCE_ROUTE_IDS.has(route.id)) {
    return null;
  }
  const target = routeShareTarget({ href: route.pathname, label });
  if (target.kind !== "Route") {
    // justify-defect: routeShareTarget must preserve its route-only contract.
    throw new Error("Route Share target factory returned a resource target");
  }
  return target;
}
