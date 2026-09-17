import type { Presence } from "@/lib/api/presence";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";

const SHARE_MODES = [
  "None",
  "CopyOnly",
  "ResourceGrants",
  "HighlightGrants",
  "LibraryMembership",
] as const;

export type ShareMode = (typeof SHARE_MODES)[number];

export function isShareMode(value: unknown): value is ShareMode {
  return SHARE_MODES.includes(value as ShareMode);
}

declare const canonicalResourceRefBrand: unique symbol;
export type CanonicalResourceRef = string & {
  readonly [canonicalResourceRefBrand]: true;
};

declare const nexusHrefBrand: unique symbol;
export type NexusHref = string & { readonly [nexusHrefBrand]: true };

export type ShareTarget =
  | { kind: "Resource"; ref: CanonicalResourceRef }
  | { kind: "Route"; href: NexusHref; label: string };

export interface ShareOpenOptions {
  returnFocusTo: ReturnFocusTarget;
  returnFocusFallback: Presence<ReturnFocusTarget>;
}

export interface ShareUserProjection {
  userHandle: string;
  email: string | null;
  displayName: string | null;
}

export const AUDIENCE_UNAVAILABLE_REASONS = [
  "UnsupportedSubject",
  "Deleting",
  "InsufficientAuthority",
  "HighlightUnresolved",
  "EntitlementRequired",
  "ProjectionNotReady",
  "ProjectionUnsupported",
] as const;

export type AudienceUnavailableReason =
  (typeof AUDIENCE_UNAVAILABLE_REASONS)[number];

export type AudienceAvailability =
  | { kind: "Available" }
  | { kind: "Unavailable"; reason: AudienceUnavailableReason };

export type OwnedShare =
  | {
      kind: "User";
      handle: string;
      user: ShareUserProjection;
    }
  | {
      kind: "Link";
      handle: string;
      publicHref: string;
    };

export interface ReceivedUserShare {
  kind: "ReceivedUser";
  handle: string;
  sharedBy: ShareUserProjection;
  subject: CanonicalResourceRef;
}

export interface ShareSnapshot {
  subject: CanonicalResourceRef;
  sharing: ShareMode;
  authenticatedHref: string;
  creationAvailability: {
    user: AudienceAvailability;
    link: AudienceAvailability;
  };
  shares: OwnedShare[];
  receivedAccess: ReceivedUserShare[];
}
