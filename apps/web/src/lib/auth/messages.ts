export const AUTH_CALLBACK_FAILURE_MESSAGE =
  "We couldn't complete sign in. Please try again.";
export const AUTH_CALLBACK_CANCELLED_MESSAGE =
  "Sign in was cancelled. Please try again.";

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

  return null;
}
