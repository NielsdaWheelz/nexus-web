import "server-only";

import { NextResponse } from "next/server";
import {
  confirmEmail,
  parseEmailConfirmationToken,
  type EmailLinkKind,
} from "@/lib/auth/email-confirmation";
import { parseEmailConfirmationForm } from "@/lib/auth/form-fields";
import {
  authFormFailure,
  readSameOriginAuthForm,
} from "@/lib/auth/form-response";
import { noStore } from "@/lib/auth/no-store";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";

/**
 * Owns the shared invite/recovery token-consumption protocol. Route wrappers
 * supply a compile-time literal purpose; no request field can select it.
 */
export async function handleEmailConfirmation(
  request: Request,
  purpose: EmailLinkKind,
): Promise<NextResponse> {
  const requestForm = await readSameOriginAuthForm(request);
  if (requestForm.kind === "Rejected") {
    return requestForm.response;
  }

  const form = parseEmailConfirmationForm(requestForm.formData);
  const token = parseEmailConfirmationToken({
    tokenHash: form?.tokenHash,
  });
  if (token.kind === "Invalid") {
    return authFormFailure({
      body: { kind: "InvalidOrExpired" },
      status: 400,
    });
  }

  const auth = await createRouteHandlerClient();
  const outcome = await confirmEmail({
    supabase: auth.supabase,
    purpose,
    tokenHash: token.tokenHash,
  });

  switch (outcome.kind) {
    case "Confirmed": {
      await auth.settlePendingCookieWrites();
      return auth.applyCookies(
        noStore(
          NextResponse.redirect(
            new URL("/account/password", requestForm.origin),
            { status: 303 },
          ),
        ),
      );
    }
    case "InvalidOrExpired":
      return authFormFailure({ body: outcome, status: 400 });
    case "RateLimited":
      return authFormFailure({ body: outcome, status: 429 });
    case "ServiceUnavailable":
      return authFormFailure({ body: outcome, status: 503 });
  }

  outcome satisfies never;
}
