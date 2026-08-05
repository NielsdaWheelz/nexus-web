import {
  type AuthError,
  isAuthError,
  isAuthRetryableFetchError,
} from "@supabase/supabase-js";

export type EmailLinkKind = "invite" | "recovery";

export type EmailConfirmationTokenHash = string & {
  readonly __emailConfirmationTokenHash: unique symbol;
};

export type EmailConfirmationTokenParseOutcome =
  | { kind: "Valid"; tokenHash: EmailConfirmationTokenHash }
  | { kind: "Invalid" };

export type EmailConfirmationOutcome =
  | { kind: "Confirmed"; purpose: EmailLinkKind }
  | { kind: "InvalidOrExpired" }
  | { kind: "RateLimited" }
  | { kind: "ServiceUnavailable" };

interface EmailConfirmationAuthClient {
  auth: {
    verifyOtp(input: { token_hash: string; type: EmailLinkKind }): Promise<{
      data: { session: object | null };
      error: AuthError | null;
    }>;
  };
}

export function parseEmailConfirmationToken(input: {
  tokenHash: unknown;
}): EmailConfirmationTokenParseOutcome {
  if (
    typeof input.tokenHash !== "string" ||
    input.tokenHash.trim().length === 0
  ) {
    return { kind: "Invalid" };
  }

  return {
    kind: "Valid",
    // justify-type-assertion: this parser is the sole ingress for the opaque
    // provider token hash; it has established the only local invariant
    // (non-empty string) without rewriting credential bytes.
    tokenHash: input.tokenHash as EmailConfirmationTokenHash,
  };
}

function unexpectedConfirmationError(
  purpose: EmailLinkKind,
  error: AuthError,
): never {
  // justify-defect: every provider error reachable for the fixed invite or
  // recovery verification operation must be projected explicitly; accepting a
  // new or purpose-incompatible state would widen a credential boundary.
  throw new Error(
    `Unexpected Supabase ${purpose} confirmation error code: ${error.code ?? "missing"}`,
  );
}

function projectEmailConfirmationOutcome(input: {
  purpose: EmailLinkKind;
  error: AuthError | null;
}): EmailConfirmationOutcome {
  if (!input.error) {
    return { kind: "Confirmed", purpose: input.purpose };
  }
  if (isAuthRetryableFetchError(input.error)) {
    return { kind: "ServiceUnavailable" };
  }

  switch (input.error.code) {
    case "otp_expired":
    case "user_banned":
    case "user_not_found":
    case "validation_failed":
      return { kind: "InvalidOrExpired" };
    case "invite_not_found":
      return input.purpose === "invite"
        ? { kind: "InvalidOrExpired" }
        : unexpectedConfirmationError(input.purpose, input.error);
    case "over_request_rate_limit":
      return { kind: "RateLimited" };
    case "request_timeout":
    case "unexpected_failure":
      return { kind: "ServiceUnavailable" };
    default:
      return unexpectedConfirmationError(input.purpose, input.error);
  }
}

export async function confirmEmail(input: {
  supabase: EmailConfirmationAuthClient;
  purpose: EmailLinkKind;
  tokenHash: EmailConfirmationTokenHash;
}): Promise<EmailConfirmationOutcome> {
  let result: Awaited<
    ReturnType<EmailConfirmationAuthClient["auth"]["verifyOtp"]>
  >;
  try {
    result = await input.supabase.auth.verifyOtp({
      token_hash: input.tokenHash,
      type: input.purpose,
    });
  } catch (cause) {
    if (!isAuthError(cause)) {
      throw cause;
    }
    return projectEmailConfirmationOutcome({
      purpose: input.purpose,
      error: cause,
    });
  }

  const outcome = projectEmailConfirmationOutcome({
    purpose: input.purpose,
    error: result.error,
  });
  if (outcome.kind !== "Confirmed" || result.data.session) {
    return outcome;
  }

  // justify-defect: verifyOtp success must establish a session for an invite
  // or recovery link; success without it is a malformed provider payload.
  throw new Error(`Supabase ${input.purpose} confirmation returned no session`);
}
