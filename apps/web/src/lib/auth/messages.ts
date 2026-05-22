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
export const SESSION_ENDED_MESSAGE = "Your session ended. Please sign in again.";

export const PASSWORD_SIGN_IN_FAILURE_MESSAGE = "Email or password is incorrect.";
export const PASSWORD_SIGN_UP_FAILURE_MESSAGE = "We couldn't create your account. Please try again.";
export const PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE = "An account with that email already exists.";
export const PASSWORD_TOO_SHORT_MESSAGE = "Password must be at least 12 characters.";
export const PASSWORD_CHANGE_FAILURE_MESSAGE = "We couldn't change your password. Please try again.";
export const PASSWORD_REMOVE_FAILURE_MESSAGE = "We couldn't remove your password. Please try again.";
export const PASSWORD_CHANGE_SUCCESS_MESSAGE = "Password updated.";
export const PASSWORD_SET_SUCCESS_MESSAGE = "Password set.";
export const PASSWORD_REMOVE_SUCCESS_MESSAGE = "Password removed.";
export const EMAIL_CHANGE_FAILURE_MESSAGE = "We couldn't update your email. Please try again.";
export const EMAIL_IN_USE_MESSAGE = "An account with that email already exists.";
export const EMAIL_CHANGE_SUCCESS_MESSAGE = "Email updated.";
export const DISPLAY_NAME_CHANGE_FAILURE_MESSAGE = "We couldn't update your display name. Please try again.";
export const DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE = "Display name updated.";
export const KEEP_ONE_SIGN_IN_METHOD_MESSAGE = "Keep at least one sign-in method.";

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

  if (trimmed === PASSWORD_SIGN_IN_FAILURE_MESSAGE) {
    return PASSWORD_SIGN_IN_FAILURE_MESSAGE;
  }

  if (trimmed === PASSWORD_SIGN_UP_FAILURE_MESSAGE) {
    return PASSWORD_SIGN_UP_FAILURE_MESSAGE;
  }

  if (trimmed === PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE) {
    return PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE;
  }

  if (trimmed === PASSWORD_TOO_SHORT_MESSAGE) {
    return PASSWORD_TOO_SHORT_MESSAGE;
  }

  if (trimmed === PASSWORD_CHANGE_FAILURE_MESSAGE) {
    return PASSWORD_CHANGE_FAILURE_MESSAGE;
  }

  if (trimmed === PASSWORD_REMOVE_FAILURE_MESSAGE) {
    return PASSWORD_REMOVE_FAILURE_MESSAGE;
  }

  if (trimmed === PASSWORD_CHANGE_SUCCESS_MESSAGE) {
    return PASSWORD_CHANGE_SUCCESS_MESSAGE;
  }

  if (trimmed === PASSWORD_SET_SUCCESS_MESSAGE) {
    return PASSWORD_SET_SUCCESS_MESSAGE;
  }

  if (trimmed === PASSWORD_REMOVE_SUCCESS_MESSAGE) {
    return PASSWORD_REMOVE_SUCCESS_MESSAGE;
  }

  if (trimmed === EMAIL_CHANGE_FAILURE_MESSAGE) {
    return EMAIL_CHANGE_FAILURE_MESSAGE;
  }

  if (trimmed === EMAIL_IN_USE_MESSAGE) {
    return EMAIL_IN_USE_MESSAGE;
  }

  if (trimmed === EMAIL_CHANGE_SUCCESS_MESSAGE) {
    return EMAIL_CHANGE_SUCCESS_MESSAGE;
  }

  if (trimmed === DISPLAY_NAME_CHANGE_FAILURE_MESSAGE) {
    return DISPLAY_NAME_CHANGE_FAILURE_MESSAGE;
  }

  if (trimmed === DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE) {
    return DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE;
  }

  if (trimmed === KEEP_ONE_SIGN_IN_METHOD_MESSAGE) {
    return KEEP_ONE_SIGN_IN_METHOD_MESSAGE;
  }

  if (normalized.includes("invalid login credentials")) {
    return PASSWORD_SIGN_IN_FAILURE_MESSAGE;
  }

  if (
    normalized.includes("user already registered") ||
    normalized.includes("already been registered")
  ) {
    return PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE;
  }

  if (normalized.includes("password should be at least")) {
    return PASSWORD_TOO_SHORT_MESSAGE;
  }

  if (normalized.includes("email rate limit exceeded")) {
    return null;
  }

  if (
    normalized.includes("already in use") ||
    (normalized.includes("email address") && normalized.includes("already"))
  ) {
    return EMAIL_IN_USE_MESSAGE;
  }

  return null;
}
