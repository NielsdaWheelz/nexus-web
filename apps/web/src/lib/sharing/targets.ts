import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import {
  formatResourceRef,
  parseResourceRef,
  type ResourceRef,
} from "@/lib/resourceGraph/resourceRef";
import type {
  CanonicalResourceRef,
  NexusHref,
  ShareTarget,
} from "@/lib/sharing/types";

function canonicalPathname(raw: string): string | null {
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("\\")
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, "https://nexus.invalid");
  } catch {
    return null;
  }
  if (
    parsed.origin !== "https://nexus.invalid" ||
    parsed.pathname !== raw ||
    parsed.pathname.split("/").some((part) => part === "." || part === "..") ||
    resolvePaneRoute(parsed.pathname).id === "unsupported"
  ) {
    return null;
  }
  return parsed.pathname;
}

export function assumeCanonicalResourceRef(raw: string): CanonicalResourceRef {
  if (!parseResourceRef(raw)) {
    throw new Error(`Invalid canonical ResourceRef: ${JSON.stringify(raw)}`);
  }
  return raw as CanonicalResourceRef;
}

export function canonicalResourceRef(ref: ResourceRef): CanonicalResourceRef {
  return assumeCanonicalResourceRef(formatResourceRef(ref));
}

export function assumeNexusHref(raw: string): NexusHref {
  const pathname = canonicalPathname(raw);
  if (!pathname) {
    throw new Error(`Invalid canonical Nexus href: ${JSON.stringify(raw)}`);
  }
  return pathname as NexusHref;
}

export function resourceShareTarget(rawRef: string): ShareTarget {
  return { kind: "Resource", ref: assumeCanonicalResourceRef(rawRef) };
}

export function routeShareTarget(input: {
  href: string;
  label: string;
}): ShareTarget {
  return {
    kind: "Route",
    href: assumeNexusHref(input.href),
    label: input.label.trim() || "Nexus",
  };
}

export function absoluteNexusHref(href: NexusHref): string {
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_PUBLIC_ORIGIN;
  if (!configuredOrigin) {
    throw new Error("Canonical Nexus public origin is unavailable");
  }
  return new URL(href, configuredOrigin).toString();
}
