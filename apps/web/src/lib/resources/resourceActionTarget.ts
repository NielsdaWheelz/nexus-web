import type { ResourceActivation } from "@/lib/resources/activation";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import {
  expectBoolean,
  expectExactRecord,
  expectNullableString,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export interface ResourceActionSubject {
  kind: "Resource";
  ref: CanonicalResourceRef;
  activation: ResourceActivation;
  missing: boolean;
}

export interface ExternalActionTarget {
  kind: "External";
  href: string;
}

export type StandingActionTarget =
  | ResourceActionSubject
  | ExternalActionTarget;

export function routeResourceActionSubject({
  scheme,
  id,
  href,
}: {
  readonly scheme: ResourceScheme;
  readonly id: string;
  readonly href: string;
}): ResourceActionSubject {
  const ref = assumeCanonicalResourceRef(`${scheme}:${id}`);
  return {
    kind: "Resource",
    ref,
    activation: {
      resourceRef: ref,
      kind: "route",
      href,
      unresolvedReason: null,
    },
    missing: false,
  };
}

function decodeResourceActivation(
  raw: unknown,
  name: string,
): ResourceActivation {
  const value = expectExactRecord(
    raw,
    ["resourceRef", "kind", "href", "unresolvedReason"],
    name,
  );
  const resourceRef = expectString(value.resourceRef, `${name}.resourceRef`);
  const kind = expectOneOf(
    value.kind,
    ["route", "external", "none"] as const,
    `${name}.kind`,
  );
  const href = expectNullableString(value.href, `${name}.href`);
  const unresolvedReason = expectNullableString(
    value.unresolvedReason,
    `${name}.unresolvedReason`,
  );
  if ((kind === "route" || kind === "external") && href === null) {
    // justify-defect: owned activation variants route and external require the
    // destination that their discriminator promises.
    throw new TypeError(`${name}.href must be a string for ${kind}`);
  }
  if (kind === "none" && href !== null) {
    // justify-defect: owned unrouteable activations cannot carry an executable
    // destination without contradicting their discriminator.
    throw new TypeError(`${name}.href must be null for none`);
  }
  return { resourceRef, kind, href, unresolvedReason };
}

export function decodeStandingActionTarget(
  raw: unknown,
  name = "StandingActionTarget",
): StandingActionTarget {
  const value = expectExactRecord(
    raw,
    raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).kind === "Resource"
      ? ["kind", "ref", "activation", "missing"]
      : ["kind", "href"],
    name,
  );

  if (value.kind === "External") {
    return {
      kind: "External",
      href: expectString(value.href, `${name}.href`),
    };
  }
  if (value.kind !== "Resource") {
    // justify-defect: this same-system discriminated target has no third
    // variant; wire drift must not silently downgrade to an external link.
    throw new TypeError(`${name}.kind must be Resource or External`);
  }

  const ref = assumeCanonicalResourceRef(
    expectString(value.ref, `${name}.ref`),
  );
  const activation = decodeResourceActivation(
    value.activation,
    `${name}.activation`,
  );
  if (activation.resourceRef !== ref) {
    // justify-defect: one action target cannot safely identify two canonical
    // resources at once.
    throw new TypeError(`${name}.ref must equal ${name}.activation.resourceRef`);
  }
  return {
    kind: "Resource",
    ref,
    activation,
    missing: expectBoolean(value.missing, `${name}.missing`),
  };
}
