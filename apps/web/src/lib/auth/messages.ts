export const AUTH_CALLBACK_FAILURE_MESSAGE =
  "We couldn't complete sign in. Please try again.";
export const AUTH_CALLBACK_CANCELLED_MESSAGE =
  "Sign in was cancelled. Please try again.";
export const OAUTH_START_FAILURE_MESSAGE =
  "We couldn't start sign in. Please try again.";

// Shown on /login after a forced sign-out: a refresh failed, or the session was
// revoked. Stated plainly — never an opaque "session expired" — per the
// cutover's forced-logout UX rule. The /auth/refresh route sets this exact
// string as the `error_description` it redirects with.
export const SESSION_ENDED_MESSAGE = "Your session ended. Please sign in again.";

const CANCELLED_ERROR_CODES = new Set([
  "access_denied",
  "user_denied",
  "consent_required",
]);

export function toPublicAuthErrorMessage(
  rawError: string | null | undefined
): string | null {
  if (!rawError) {
    return null;
  }

  const trimmed = rawError.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (CANCELLED_ERROR_CODES.has(normalized)) {
    return AUTH_CALLBACK_CANCELLED_MESSAGE;
  }

  if (trimmed === AUTH_CALLBACK_FAILURE_MESSAGE) {
    return AUTH_CALLBACK_FAILURE_MESSAGE;
  }

  if (trimmed === AUTH_CALLBACK_CANCELLED_MESSAGE) {
    return AUTH_CALLBACK_CANCELLED_MESSAGE;
  }

  if (trimmed === OAUTH_START_FAILURE_MESSAGE) {
    return OAUTH_START_FAILURE_MESSAGE;
  }

  if (trimmed === SESSION_ENDED_MESSAGE) {
    return SESSION_ENDED_MESSAGE;
  }

  return null;
}
