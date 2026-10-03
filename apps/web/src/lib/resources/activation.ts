import type { Schema } from "@/lib/api/wire";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import {
  expectExactRecord,
  expectNullableString,
  expectOneOf,
  expectString,
} from "@/lib/validation";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";

/** Canonical activation wire; untyped and replayed inputs use the decoder below. */
export type ResourceActivation = Schema<"ResourceActivationOut">;

export function decodeResourceActivation(
  raw: unknown,
  name = "resource activation",
): ResourceActivation {
  const value = expectExactRecord(
    raw,
    ["resource_ref", "kind", "href", "unresolved_reason"],
    name,
  );
  const resourceRef = expectString(value.resource_ref, `${name}.resource_ref`);
  if (parseResourceRef(resourceRef) === null) {
    throw new TypeError(`${name}.resource_ref must be a canonical ResourceRef`);
  }
  const kind = expectOneOf(
    value.kind,
    ["route", "external", "none"] as const,
    `${name}.kind`,
  );
  const href = expectNullableString(value.href, `${name}.href`);
  const unresolvedReason = expectNullableString(
    value.unresolved_reason,
    `${name}.unresolved_reason`,
  );
  if (kind === "none" && href !== null) {
    throw new TypeError(`${name}.href must be null for none`);
  }
  if (kind !== "none" && href === null) {
    throw new TypeError(`${name}.href must be a string for ${kind}`);
  }
  return {
    resource_ref: resourceRef,
    kind,
    href,
    unresolved_reason: unresolvedReason,
  };
}

/** Nullable adapter for replayed or independently persisted snake_case data. */
export function normalizeResourceActivation(
  raw: unknown,
): ResourceActivation | null {
  try {
    return decodeResourceActivation(raw);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
}

export function hrefForResourceActivation(
  activation: ResourceActivation,
): string | null {
  return activation.href;
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
  input.activateTarget({
    target: {
      href,
      ...(input.labelHint ? { labelHint: input.labelHint } : {}),
    },
    disposition: input.disposition,
  });
  return true;
}
