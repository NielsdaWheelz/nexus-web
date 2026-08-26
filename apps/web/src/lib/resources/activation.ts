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

interface ResourceActivationBase {
  resourceRef: string;
  unresolvedReason: string | null;
}

export type ResourceActivation =
  | (ResourceActivationBase & {
      kind: "route" | "external";
      href: string;
    })
  | (ResourceActivationBase & { kind: "none"; href: null });

const SNAKE_CASE_KEYS = {
  resourceRef: "resource_ref",
  kind: "kind",
  href: "href",
  unresolvedReason: "unresolved_reason",
} as const;

const CAMEL_CASE_KEYS = {
  resourceRef: "resourceRef",
  kind: "kind",
  href: "href",
  unresolvedReason: "unresolvedReason",
} as const;

type ActivationKeys = typeof SNAKE_CASE_KEYS | typeof CAMEL_CASE_KEYS;

function decodeActivationFields(
  value: Record<string, unknown>,
  keys: ActivationKeys,
  name: string,
): ResourceActivation {
  const resourceRef = expectString(
    value[keys.resourceRef],
    `${name}.${keys.resourceRef}`,
  );
  if (parseResourceRef(resourceRef) === null) {
    throw new TypeError(
      `${name}.${keys.resourceRef} must be a canonical ResourceRef`,
    );
  }
  const kind = expectOneOf(
    value[keys.kind],
    ["route", "external", "none"] as const,
    `${name}.${keys.kind}`,
  );
  const href = expectNullableString(value[keys.href], `${name}.${keys.href}`);
  const unresolvedReason = expectNullableString(
    value[keys.unresolvedReason],
    `${name}.${keys.unresolvedReason}`,
  );
  if (kind === "none") {
    if (href !== null) {
      throw new TypeError(`${name}.${keys.href} must be null for none`);
    }
    return { resourceRef, kind, href, unresolvedReason };
  }
  if (href === null) {
    throw new TypeError(`${name}.${keys.href} must be a string for ${kind}`);
  }
  return { resourceRef, kind, href, unresolvedReason };
}

/** Strict decoder for same-system snake_case activation wires. */
export function decodeSnakeCaseResourceActivation(
  raw: unknown,
  name = "resource activation",
): ResourceActivation {
  const value = expectExactRecord(
    raw,
    Object.values(SNAKE_CASE_KEYS),
    name,
  );
  return decodeActivationFields(value, SNAKE_CASE_KEYS, name);
}

/** Strict decoder for same-system camelCase activation wires. */
export function decodeCamelCaseResourceActivation(
  raw: unknown,
  name = "resource activation",
): ResourceActivation {
  const value = expectExactRecord(
    raw,
    Object.values(CAMEL_CASE_KEYS),
    name,
  );
  return decodeActivationFields(value, CAMEL_CASE_KEYS, name);
}

/** Nullable adapter for replayed or independently persisted snake_case data. */
export function normalizeResourceActivation(
  raw: unknown,
): ResourceActivation | null {
  try {
    return decodeSnakeCaseResourceActivation(raw);
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
