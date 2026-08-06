import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import {
  expectExactRecord,
  expectString,
} from "@/lib/validation";

/** The complete, location-independent identity accepted by resource actions. */
export interface ResourceActionSubject {
  readonly ref: CanonicalResourceRef;
}

/** Strict same-system decoder. Activation and missing state belong to snapshots. */
export function decodeResourceActionSubject(
  raw: unknown,
  name = "ResourceActionSubject",
): ResourceActionSubject {
  const value = expectExactRecord(raw, ["ref"], name);
  return {
    ref: assumeCanonicalResourceRef(expectString(value.ref, `${name}.ref`)),
  };
}
