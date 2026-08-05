import "server-only";

import { NextResponse } from "next/server";
import { resolveCallbackRedirectOrigin } from "@/lib/auth/callback-origin";
import { noStore } from "@/lib/auth/no-store";
import type {
  PasswordRecoveryOutcome,
  PasswordSignInOutcome,
  PasswordUpdateOutcome,
} from "@/lib/auth/password-flow";
import type { EmailConfirmationOutcome } from "@/lib/auth/email-confirmation";

type AuthFormFailure =
  | { kind: "Forbidden" }
  | { kind: "InvalidRequest" }
  | Exclude<PasswordSignInOutcome, { kind: "SignedIn" }>
  | Exclude<PasswordRecoveryOutcome, { kind: "Requested" }>
  | Exclude<PasswordUpdateOutcome, { kind: "Saved" | "SessionEnded" }>
  | Exclude<EmailConfirmationOutcome, { kind: "Confirmed" }>;

type AuthFormRequest =
  | { kind: "Accepted"; formData: FormData; origin: string }
  | { kind: "Rejected"; response: NextResponse };

export function authFormFailure(input: {
  body: AuthFormFailure;
  status: 400 | 401 | 403 | 429 | 503;
}): NextResponse {
  return noStore(NextResponse.json(input.body, { status: input.status }));
}

export async function readSameOriginAuthForm(
  request: Request,
): Promise<AuthFormRequest> {
  const origin = resolveCallbackRedirectOrigin(request);
  if (request.headers.get("origin") !== origin) {
    return {
      kind: "Rejected",
      response: authFormFailure({
        body: { kind: "Forbidden" },
        status: 403,
      }),
    };
  }

  try {
    return {
      kind: "Accepted",
      formData: await request.formData(),
      origin,
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // justify-ignore-error: malformed browser form encoding is expected
    // untrusted input; the fixed response intentionally exposes no parser or
    // submitted-value detail.
    return {
      kind: "Rejected",
      response: authFormFailure({
        body: { kind: "InvalidRequest" },
        status: 400,
      }),
    };
  }
}
