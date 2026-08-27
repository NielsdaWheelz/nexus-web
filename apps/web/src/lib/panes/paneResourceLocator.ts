import type { ResolvedPaneRouteModel } from "@/lib/panes/paneRouteModel";
import {
  formatResourceRef,
  parseResourceRef,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";
import { parseContributorHandle } from "@/lib/contributors/handle";
import { routeShareTarget } from "@/lib/sharing/targets";
import type { ShareTarget } from "@/lib/sharing/types";
import { expectExactRecord, expectOneOf, expectString } from "@/lib/validation";

export type PaneResourceLocator =
  | { kind: "resource_ref"; ref: string }
  | { kind: "contributor_handle"; handle: string };

export type PaneRouteShareIdentity = Extract<ShareTarget, { kind: "Route" }>;

/** Strict same-system decoder for the two locator variants the server echoes. */
export function decodePaneResourceLocator(raw: unknown): PaneResourceLocator {
  const candidate = expectExactRecord(
    raw,
    raw !== null &&
      typeof raw === "object" &&
      "kind" in raw &&
      raw.kind === "contributor_handle"
      ? ["kind", "handle"]
      : ["kind", "ref"],
    "pane resource locator",
  );
  const kind = expectOneOf(
    candidate.kind,
    ["resource_ref", "contributor_handle"] as const,
    "pane resource locator.kind",
  );
  if (kind === "resource_ref") {
    const ref = expectString(candidate.ref, "pane resource locator.ref");
    if (parseResourceRef(ref) === null) {
      throw new TypeError("pane resource locator.ref must be canonical");
    }
    return { kind, ref };
  }
  const handle = expectString(candidate.handle, "pane resource locator.handle");
  parseContributorHandle(handle);
  return { kind, handle };
}

export function paneResourceLocatorKey(
  locator: PaneResourceLocator | null,
): string | null {
  if (!locator) return null;
  switch (locator.kind) {
    case "resource_ref":
      return `resource_ref:${locator.ref}`;
    case "contributor_handle":
      return `contributor_handle:${locator.handle}`;
  }
}

export function samePaneResourceLocator(
  left: PaneResourceLocator,
  right: PaneResourceLocator,
): boolean {
  return paneResourceLocatorKey(left) === paneResourceLocatorKey(right);
}

function resourceRefLocator(
  scheme: ResourceScheme,
  id: string | undefined,
): PaneResourceLocator | null {
  if (!id) return null;
  const ref = formatResourceRef({ scheme, id });
  return parseResourceRef(ref) ? { kind: "resource_ref", ref } : null;
}

function namespacedResourceRefLocator(
  scheme: ResourceScheme,
  ref: string | undefined,
): PaneResourceLocator | null {
  if (!ref) return null;
  const parsed = parseResourceRef(ref);
  return parsed?.scheme === scheme ? { kind: "resource_ref", ref } : null;
}

export function resolvePaneResourceLocator(
  route: Pick<ResolvedPaneRouteModel, "id" | "params">,
): PaneResourceLocator | null {
  if (route.id === "library")
    return resourceRefLocator("library", route.params.id);
  if (route.id === "media") return resourceRefLocator("media", route.params.id);
  if (route.id === "artifact") {
    return namespacedResourceRefLocator("artifact", route.params.artifactRef);
  }
  if (route.id === "conversation") {
    return resourceRefLocator("conversation", route.params.id);
  }
  if (route.id === "podcastDetail") {
    return resourceRefLocator("podcast", route.params.podcastId);
  }
  if (route.id === "page")
    return resourceRefLocator("page", route.params.pageId);
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
const RESOURCE_IDENTITY_ROUTE_IDS = new Set([
  "library",
  "media",
  "artifact",
  "conversation",
  "podcastDetail",
  "page",
  "note",
  "oracleReading",
  "author",
  // A latent daily date has no durable resource to share. Once materialized,
  // PagePaneBody publishes the decoded Page identity through pane chrome.
  "dailyDate",
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
  if (RESOURCE_IDENTITY_ROUTE_IDS.has(route.id)) {
    return null;
  }
  const target = routeShareTarget({ href: route.pathname, label });
  if (target.kind !== "Route") {
    // justify-defect: routeShareTarget must preserve its route-only contract.
    throw new Error("Route Share target factory returned a resource target");
  }
  return target;
}
