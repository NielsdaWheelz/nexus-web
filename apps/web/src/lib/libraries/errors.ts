// Library, entry, placement, membership and sharing commands: whether a failure settles one, and
// how a refusal is said. A domain code names the server rule that refused, as a reason; every
// other code takes the transport's line and verb. Domain codes come ahead of `transportOf`, so
// nothing here restates a transport. Only a sent command can have an unknown outcome.

import type { Outcome } from "@/components/feedback/Feedback";
import type { Retract } from "@/components/feedback/stage";
import { isApiError } from "@/lib/api/client";

const GONE = "it’s no longer available.";
/** The server's name rule, where a refused name is said. */
export const NAME_REFUSED = "names need 1 to 100 characters, and can’t be All.";
const REASONS: Readonly<Record<string, string>> = {
  E_LIBRARY_NOT_FOUND: "you no longer have this library.",
  E_MEDIA_NOT_FOUND: GONE,
  E_NOT_FOUND: GONE,
  E_FORBIDDEN: "only its admins can do that.",
  E_OWNER_REQUIRED: "only its owner can do that.",
  E_LIBRARY_FORBIDDEN: "nexus manages this library.",
  E_DEFAULT_LIBRARY_FORBIDDEN: "All can’t be changed this way.",
  E_OWNER_EXIT_FORBIDDEN: "the owner can’t leave or change role.",
  E_MEDIA_DELETING: "it’s being deleted.",
  E_INVITE_NOT_PENDING: "that invitation is no longer pending.",
  E_INVITE_NOT_FOUND: "that invitation is no longer pending.",
  E_INVITE_ALREADY_EXISTS: "they already have a pending invitation.",
  E_INVITE_MEMBER_EXISTS: "they’re already a member.",
  E_OWNERSHIP_TRANSFER_INVALID: "only a current member can become owner.",
  E_USER_NOT_FOUND: "this account no longer exists.",
  /** A dialog with a name input says this beneath it instead. */
  E_NAME_INVALID: NAME_REFUSED,
};

/** The rule that refused a library command, or null when the transport speaks. */
export function libraryReason(error: unknown): string | null {
  return isApiError(error) ? REASONS[error.code] ?? null : null;
}

/** A refused library command: `fact` with the rule that refused it, else the transport's reason and
 * verb. A generic conflict does not identify what refused it. */
export function refuseLibrary(outcome: Outcome, error: unknown, fact: string): Retract {
  const reason = libraryReason(error);
  return reason === null ? outcome.fail(error, fact) : outcome.say({ fact, reason });
}
