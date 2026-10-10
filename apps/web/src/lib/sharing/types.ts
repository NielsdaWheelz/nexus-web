import type { Presence } from "@/lib/api/presence";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";

export type ShareMode =
  | "None"
  | "CopyOnly"
  | "ResourceGrants"
  | "HighlightGrants"
  | "LibraryMembership";

declare const canonicalResourceRefBrand: unique symbol;
export type CanonicalResourceRef = string & {
  readonly [canonicalResourceRefBrand]: true;
};

/** A resource to grant, or a pane route that can only be copied (href is its pathname). */
export type ShareTarget =
  { kind: "Resource"; ref: CanonicalResourceRef } | { kind: "Route"; href: string; label: string };

export interface ShareOpenOptions {
  returnFocusTo: ReturnFocusTarget;
  returnFocusFallback: Presence<ReturnFocusTarget>;
}
