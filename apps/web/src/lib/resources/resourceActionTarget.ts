import type { CanonicalResourceRef } from "@/lib/sharing/types";

/** The complete, location-independent identity accepted by resource actions. */
export interface ResourceActionSubject {
  readonly ref: CanonicalResourceRef;
}
