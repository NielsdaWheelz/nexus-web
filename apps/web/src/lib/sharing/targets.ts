import {
  formatResourceRef,
  parseResourceRef,
  type ResourceRef,
} from "@/lib/resourceGraph/resourceRef";
import type { CanonicalResourceRef, ShareTarget } from "@/lib/sharing/types";

export function assumeCanonicalResourceRef(raw: string): CanonicalResourceRef {
  if (!parseResourceRef(raw)) {
    throw new Error(`Invalid canonical ResourceRef: ${JSON.stringify(raw)}`);
  }
  return raw as CanonicalResourceRef;
}

export function canonicalResourceRef(ref: ResourceRef): CanonicalResourceRef {
  return assumeCanonicalResourceRef(formatResourceRef(ref));
}

export function resourceShareTarget(rawRef: string): ShareTarget {
  return { kind: "Resource", ref: assumeCanonicalResourceRef(rawRef) };
}

/** A pane route's Share target; `href` is the pathname of a route already resolved as supported. */
export function routeShareTarget(input: { href: string; label: string }): ShareTarget {
  return {
    kind: "Route",
    href: input.href,
    label: input.label.trim() || "Nexus",
  };
}
