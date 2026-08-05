import {
  type AuthError,
  isAuthError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  isAuthWeakPasswordError,
} from "@supabase/supabase-js";

export type PasswordSignInOutcome =
  | { kind: "SignedIn" }
  | { kind: "InvalidCredentials" }
  | { kind: "RateLimited" }
  | { kind: "ServiceUnavailable" };

export type PasswordRecoveryOutcome =
  | { kind: "Requested" }
  | { kind: "RateLimited" }
  | { kind: "ServiceUnavailable" };

export type PasswordUpdateOutcome =
  | { kind: "Saved" }
  | { kind: "PolicyRejected"; reasons: readonly ["length"] }
  | { kind: "SessionEnded" }
  | { kind: "RateLimited" }
  | { kind: "ServiceUnavailable" };

interface PasswordSignInClient {
  auth: {
    signInWithPassword(input: { email: string; password: string }): Promise<{
      data: { session: unknown } | null;
      error: AuthError | null;
    }>;
  };
}

interface PasswordRecoveryClient {
  auth: {
    resetPasswordForEmail(email: string): Promise<{
      error: AuthError | null;
    }>;
  };
}

interface PasswordUpdateClient {
  auth: {
    updateUser(input: { password: string }): Promise<{
      data: { user: unknown } | null;
      error: AuthError | null;
    }>;
  };
}

function isProviderObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderUser(value: unknown): value is { id: string } {
  return (
    isProviderObject(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

function unexpectedAuthError(operation: string, error: AuthError): never {
  // justify-defect: every provider error reachable for this configured Auth
  // operation must have an explicit projection; a new or malformed state is a
  // provider-contract/configuration defect, not generic public auth feedback.
  throw new Error(
    `Unexpected Supabase ${operation} error code: ${error.code ?? "missing"}`,
  );
}

function projectPasswordSignInError(
  error: AuthError,
): Exclude<PasswordSignInOutcome, { kind: "SignedIn" }> {
  if (isAuthRetryableFetchError(error)) {
    return { kind: "ServiceUnavailable" };
  }

  switch (error.code) {
    case "invalid_credentials":
    case "email_address_invalid":
    case "email_not_confirmed":
    case "user_banned":
    case "user_not_found":
    case "validation_failed":
      return { kind: "InvalidCredentials" };
    case "over_request_rate_limit":
      return { kind: "RateLimited" };
    case "request_timeout":
    case "unexpected_failure":
      return { kind: "ServiceUnavailable" };
    default:
      return unexpectedAuthError("password sign-in", error);
  }
}

function projectPasswordRecoveryOutcome(input: {
  error: AuthError | null;
}): PasswordRecoveryOutcome {
  if (!input.error) {
    return { kind: "Requested" };
  }
  if (isAuthRetryableFetchError(input.error)) {
    // auth-js converts provider HTTP 5xx responses into this SDK type before
    // exposing their stable error code. Those failures can occur only after a
    // known account reaches email delivery, so acknowledging them preserves
    // the same public response as an unknown address. Status 0 is a transport
    // failure that occurs before account-specific provider behavior.
    return input.error.status >= 500
      ? { kind: "Requested" }
      : { kind: "ServiceUnavailable" };
  }

  switch (input.error.code) {
    case "email_address_invalid":
    case "email_address_not_authorized":
    case "email_not_confirmed":
    case "over_email_send_rate_limit":
    case "user_banned":
    case "user_not_found":
    case "validation_failed":
    case "request_timeout":
    case "unexpected_failure":
      return { kind: "Requested" };
    case "over_request_rate_limit":
      return { kind: "RateLimited" };
    default:
      return unexpectedAuthError("password recovery", input.error);
  }
}

function projectPasswordUpdateError(error: AuthError): PasswordUpdateOutcome {
  if (isAuthRetryableFetchError(error)) {
    return { kind: "ServiceUnavailable" };
  }
  if (isAuthSessionMissingError(error)) {
    return { kind: "SessionEnded" };
  }
  if (isAuthWeakPasswordError(error)) {
    if (error.reasons.length !== 1 || error.reasons[0] !== "length") {
      // justify-defect: hosted password policy is verified as length-only. Any
      // other reason is configuration or provider-contract drift and must not
      // cross the owned server boundary as an expected public outcome.
      throw new Error("Unexpected Supabase password policy reasons");
    }
    return { kind: "PolicyRejected", reasons: ["length"] };
  }

  switch (error.code) {
    case "same_password":
      return { kind: "Saved" };
    case "session_not_found":
    case "session_expired":
    case "user_banned":
    case "user_not_found":
      return { kind: "SessionEnded" };
    case "conflict":
      return { kind: "ServiceUnavailable" };
    case "over_request_rate_limit":
      return { kind: "RateLimited" };
    case "request_timeout":
    case "unexpected_failure":
      return { kind: "ServiceUnavailable" };
    default:
      return unexpectedAuthError("password update", error);
  }
}

export async function signInWithPasswordFlow(input: {
  supabase: PasswordSignInClient;
  email: string;
  password: string;
}): Promise<PasswordSignInOutcome> {
  let result: Awaited<
    ReturnType<PasswordSignInClient["auth"]["signInWithPassword"]>
  >;
  try {
    result = await input.supabase.auth.signInWithPassword({
      email: input.email.trim().toLowerCase(),
      password: input.password,
    });
  } catch (cause) {
    if (!isAuthError(cause)) {
      throw cause;
    }
    return projectPasswordSignInError(cause);
  }

  if (result.error) {
    return projectPasswordSignInError(result.error);
  }
  if (!result.data || !isProviderObject(result.data.session)) {
    // justify-defect: a successful password sign-in must establish a concrete
    // provider session; redirecting without it recreates a false-success flow.
    throw new Error("Supabase password sign-in returned no session");
  }

  return { kind: "SignedIn" };
}

export async function requestPasswordRecoveryFlow(input: {
  supabase: PasswordRecoveryClient;
  email: string;
}): Promise<PasswordRecoveryOutcome> {
  let error: AuthError | null;
  try {
    ({ error } = await input.supabase.auth.resetPasswordForEmail(
      input.email.trim().toLowerCase(),
    ));
  } catch (cause) {
    if (!isAuthError(cause)) {
      throw cause;
    }
    error = cause;
  }

  return projectPasswordRecoveryOutcome({ error });
}

export async function updatePasswordFlow(input: {
  supabase: PasswordUpdateClient;
  password: string;
}): Promise<PasswordUpdateOutcome> {
  if (input.password.length < 15) {
    return { kind: "PolicyRejected", reasons: ["length"] };
  }

  let result: Awaited<ReturnType<PasswordUpdateClient["auth"]["updateUser"]>>;
  try {
    result = await input.supabase.auth.updateUser({
      password: input.password,
    });
  } catch (cause) {
    if (!isAuthError(cause)) {
      throw cause;
    }
    return projectPasswordUpdateError(cause);
  }

  if (result.error) {
    return projectPasswordUpdateError(result.error);
  }
  if (!result.data || !isProviderUser(result.data.user)) {
    // justify-defect: updateUser success must carry the affected provider user;
    // otherwise "Saved" would be an unproved mutation outcome.
    throw new Error("Supabase password update returned no user");
  }

  return { kind: "Saved" };
}
