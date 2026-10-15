// The one copy map for library, entry and placement failures. A transport
// failure gets the shared transport copy; an abort or a handled sign-out shows
// nothing; any other code is a defect, handed to `fail` (useThrowLater in a
// handler, a plain throw in render).

import type { FeedbackContent } from "@/components/feedback/Feedback";
import { apiTransportFeedback } from "@/lib/api/client";
import { modeledApiError } from "@/lib/api/serverState";

const PERMISSIONS = "Your library permissions changed. Refresh and try again.";
const GONE = "This item is no longer available.";
const COPY: Readonly<Record<string, string>> = {
  E_LIBRARY_NOT_FOUND: "This library is no longer available.",
  E_MEDIA_NOT_FOUND: GONE,
  E_NOT_FOUND: GONE,
  E_FORBIDDEN: PERMISSIONS,
  E_LIBRARY_FORBIDDEN: PERMISSIONS,
  E_OWNER_REQUIRED: PERMISSIONS,
  E_DEFAULT_LIBRARY_FORBIDDEN: PERMISSIONS,
  E_NAME_INVALID: "Enter a library name of 1 to 100 characters other than All.",
  E_RESOURCE_CONFLICT: "Someone changed this meanwhile. Refresh and try again.",
  E_MEDIA_LAST_REFERENCE: "This item must stay in at least one library.",
  E_MEDIA_DELETING: "This item is being removed and can’t be changed now.",
  E_PODCAST_SUBSCRIPTION_REQUIRED:
    "Subscribe to this podcast before adding it to a library.",
  E_INVALID_REQUEST: "That change is no longer valid. Refresh and try again.",
  E_INVALID_CURSOR: "The list changed. Refresh it and try again.",
  E_INVITE_NOT_PENDING: "This invitation is no longer pending.",
  E_INVITE_NOT_FOUND: "This invitation is no longer pending.",
};

type Fail = (defect: { readonly error: unknown }) => void;

export const throwDefect: Fail = ({ error }) => {
  throw error;
};

export function libraryErrorFeedback(
  error: unknown,
  title: string,
  fail: Fail,
): FeedbackContent | null {
  const modeled = modeledApiError(error, fail);
  if (modeled === null) return null;
  const transport = apiTransportFeedback(modeled, title);
  if (transport !== null) return transport;
  const message = COPY[modeled.code];
  if (message === undefined) {
    fail({ error: modeled });
    return null;
  }
  return { tone: "Danger", title, message, requestId: modeled.requestId };
}
