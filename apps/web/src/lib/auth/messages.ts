export const AUTH_CALLBACK_FAILURE_MESSAGE =
  "We couldn't complete sign in. Please try again.";
export const AUTH_CALLBACK_CANCELLED_MESSAGE =
  "Sign in was cancelled. Please try again.";
export const OAUTH_START_FAILURE_MESSAGE =
  "We couldn't start sign in. Please try again.";

// Shown on /login after a forced sign-out: a refresh failed, or the session was
// revoked. Stated plainly — never as an opaque "session expired". The
// /auth/refresh route sets this exact string as the `error_description` it
// redirects with.
export const SESSION_ENDED_MESSAGE =
  "Your session ended. Please sign in again.";
export const AUTH_ENDED_FEEDBACK_COOKIE = "nexus.auth-ended.v1";

export const EMAIL_CHANGE_FAILURE_MESSAGE =
  "We couldn't update your email. Please try again.";
export const EMAIL_IN_USE_MESSAGE =
  "An account with that email already exists.";
export const EMAIL_CHANGE_CONFIRMATION_SENT_MESSAGE =
  "Check your new email to confirm the change.";
export const DISPLAY_NAME_CHANGE_FAILURE_MESSAGE =
  "We couldn't update your display name. Please try again.";

const PUBLIC_AUTH_FEEDBACK = new Set([
  AUTH_CALLBACK_FAILURE_MESSAGE,
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  OAUTH_START_FAILURE_MESSAGE,
  SESSION_ENDED_MESSAGE,
]);

export function projectOAuthCallbackError(errorCode: string | null): string {
  switch (errorCode) {
    case "access_denied":
    case "user_denied":
    case "consent_required":
      return AUTH_CALLBACK_CANCELLED_MESSAGE;
    default:
      return AUTH_CALLBACK_FAILURE_MESSAGE;
  }
}

export function readPublicAuthFeedback(
  rawFeedback: string | null | undefined,
): string | null {
  return rawFeedback && PUBLIC_AUTH_FEEDBACK.has(rawFeedback)
    ? rawFeedback
    : null;
}

export function projectEmailChangeError(errorCode: string | undefined): string {
  switch (errorCode) {
    case "email_exists":
    case "email_conflict_identity_not_deletable":
      return EMAIL_IN_USE_MESSAGE;
    case "email_address_invalid":
    case "email_address_not_authorized":
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
    case "request_timeout":
    case "unexpected_failure":
    case "validation_failed":
      return EMAIL_CHANGE_FAILURE_MESSAGE;
    default:
      // justify-defect: the authenticated email-update boundary projects every
      // provider state this product supports. A new or codeless state must be
      // diagnosed instead of silently changing the user's reported outcome.
      throw new Error(
        `Unexpected Supabase email update error code: ${errorCode ?? "missing"}`,
      );
  }
}
