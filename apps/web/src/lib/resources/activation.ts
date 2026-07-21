import { isRecord } from "@/lib/validation";
import {
  parseResourceRef,
  type ResourceRef,
} from "@/lib/resourceGraph/resourceRef";

export interface ResourceActivation {
  resourceRef: string;
  kind: "route" | "external" | "none";
  href: string | null;
  unresolvedReason: string | null;
}

export function normalizeResourceActivation(
  raw: unknown,
): ResourceActivation | null {
  if (!isRecord(raw)) return null;
  const resourceRef = raw.resourceRef ?? raw.resource_ref;
  if (typeof resourceRef !== "string") return null;
  if (raw.kind !== "route" && raw.kind !== "external" && raw.kind !== "none") {
    return null;
  }
  const href = typeof raw.href === "string" ? raw.href : null;
  if ((raw.kind === "route" || raw.kind === "external") && href === null) {
    return null;
  }
  return {
    resourceRef,
    kind: raw.kind,
    href,
    unresolvedReason:
      typeof raw.unresolvedReason === "string"
        ? raw.unresolvedReason
        : typeof raw.unresolved_reason === "string"
          ? raw.unresolved_reason
          : null,
  };
}

export function hrefForResourceActivation(
  activation: ResourceActivation,
): string | null {
  return activation.href;
}

export function resourceRefForActivation(
  activation: ResourceActivation,
): ResourceRef | null {
  return parseResourceRef(activation.resourceRef);
}

export function activateResource(
  activation: ResourceActivation,
  options: {
    labelHint?: string | null;
    openInNewPane?: (href: string, labelHint?: string) => void;
    navigate?: (href: string) => void;
    newPane?: boolean;
  },
): boolean {
  const href = hrefForResourceActivation(activation);
  if (!href) return false;
  if (activation.kind === "external" && typeof window !== "undefined") {
    if (options.newPane) {
      window.open(href, "_blank", "noopener,noreferrer");
    } else {
      window.location.assign(href);
    }
    return true;
  }
  if (options.newPane && options.openInNewPane) {
    options.openInNewPane(href, options.labelHint ?? undefined);
    return true;
  }
  if (options.navigate) {
    options.navigate(href);
    return true;
  }
  if (options.openInNewPane) {
    options.openInNewPane(href, options.labelHint ?? undefined);
    return true;
  }
  return false;
}
