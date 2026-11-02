// Library, entry, placement, membership and sharing commands: whether a failure settles one, and
// how a refusal is said. A domain code names the server rule that refused, as a reason; every
// other code takes the transport's line and verb. Domain codes come ahead of `transportOf`, so
// nothing here restates a transport. Only a sent command can have an unknown outcome.

import type { FeedbackContent, Outcome } from "@/components/feedback/Feedback";
import type { Retract } from "@/components/feedback/stage";
import { admissionRefusal, apiTransportFeedback, isApiError, isRefusal, isSameSystemApiDefect, isUnauthenticatedApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { catalogErrorFeedback } from "@/lib/catalog/copy";
import { modeledApiError } from "@/lib/api/serverState";
import { remoteAttemptAllowed } from "@/lib/native/admission";

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
  E_RESOURCE_CONFLICT: "it changed meanwhile.",
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
 * verb. `conflict` names what moved, where the site knows better than `it changed meanwhile.` */
export function refuseLibrary(outcome: Outcome, error: unknown, fact: string, conflict?: string): Retract {
  const reason = isApiError(error) && error.code === "E_RESOURCE_CONFLICT" && conflict !== undefined ? conflict : libraryReason(error);
  return reason === null ? outcome.fail(error, fact) : outcome.say({ fact, reason });
}

/** True when admission would refuse the command unsent, after saying so: `fact` with admission's
 * reason and verb, and a lapsed session handed to its handler. Asked immediately before sending,
 * since apiFetch decides the same in the same tick. */
export function refusedUnsent(outcome: Outcome, fact: string): boolean {
  if (remoteAttemptAllowed()) return false;
  const refusal = admissionRefusal();
  handleUnauthenticatedApiError(refusal);
  outcome.fail(refusal, fact);
  return true;
}

/** Whether a sent command's failure leaves it possibly landed, for its owner to hold. A refusal
 * settles it, and so does a lapsed session, which ran nothing; a defect is no outcome. */
export function mayHaveLanded(error: unknown): boolean {
  return isApiError(error) && !isSameSystemApiDefect(error) && !isRefusal(error) && !isUnauthenticatedApiError(error);
}

type Fail = (defect: { readonly error: unknown }) => void;

/** Only for callers outside this lane until they move to `libraryReason`; L7 deletes it. */
export const throwDefect: Fail = ({ error }) => {
  throw error;
};

/** Only for callers outside this lane until they move to `libraryReason`; L7 deletes it. */
export function libraryErrorFeedback(
  error: unknown,
  title: string,
  fail: Fail,
  signIn?: (error: unknown) => boolean,
): FeedbackContent | null {
  const modeled = modeledApiError(error, fail, signIn);
  if (modeled === null) return null;
  const catalog = catalogErrorFeedback(modeled);
  if (catalog !== null) return catalog;
  const transport = apiTransportFeedback(modeled, title);
  if (transport !== null) return transport;
  if (modeled.status < 400 || modeled.status >= 500) {
    fail({ error: modeled });
    return null;
  }
  return { tone: "Danger", title, message: REASONS[modeled.code], requestId: modeled.requestId };
}
