import { isRecord } from "@/lib/validation";
import {
  parseResourceRef,
  type ResourceRef,
} from "@/lib/resourceGraph/resourceRef";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";

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
  const keys = Object.keys(raw).sort();
  const expected = ["href", "kind", "resource_ref", "unresolved_reason"];
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index])
  ) {
    return null;
  }
  const resourceRef = raw.resource_ref;
  if (typeof resourceRef !== "string") return null;
  if (raw.kind !== "route" && raw.kind !== "external" && raw.kind !== "none") {
    return null;
  }
  if (raw.href !== null && typeof raw.href !== "string") return null;
  const href = raw.href;
  if (
    raw.unresolved_reason !== null &&
    typeof raw.unresolved_reason !== "string"
  ) {
    return null;
  }
  if ((raw.kind === "route" || raw.kind === "external") && href === null) {
    return null;
  }
  return {
    resourceRef,
    kind: raw.kind,
    href,
    unresolvedReason:
      typeof raw.unresolved_reason === "string" ? raw.unresolved_reason : null,
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

export function secondaryActivationForResource(
  _activation: ResourceActivation,
): WorkspaceSecondaryActivation | null {
  // Artifact and Artifact Revision activations now own canonical standalone
  // `/artifacts/{ref}` routes. Resource Companion revision selection remains a
  // local `useResourceInspector` concern and is never inferred here.
  return null;
}

export function activateResource(
  activation: ResourceActivation,
  input: {
    labelHint?: string | null;
    disposition: WorkspaceTargetDisposition;
    activateTarget: (input: {
      target: WorkspaceTarget;
      disposition: WorkspaceTargetDisposition;
    }) => void;
  },
): boolean {
  const href = hrefForResourceActivation(activation);
  if (!href) return false;
  if (activation.kind === "external" && typeof window !== "undefined") {
    switch (input.disposition.kind) {
      case "Follow":
        window.location.assign(href);
        return true;
      case "Fork":
        window.open(href, "_blank", "noopener,noreferrer");
        return true;
      case "Adopt":
        // justify-defect: named adoption is a workspace-only operation and
        // cannot preserve an origin when crossing into an external browser.
        throw new Error("Cannot adopt an external resource target");
    }
  }
  const secondaryActivation = secondaryActivationForResource(activation);
  input.activateTarget({
    target: {
      href,
      ...(input.labelHint ? { labelHint: input.labelHint } : {}),
      ...(secondaryActivation ? { secondaryActivation } : {}),
    },
    disposition: input.disposition,
  });
  return true;
}
