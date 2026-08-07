import { NextResponse } from "next/server";
import {
  authFormFailure,
  readSameOriginAuthForm,
} from "@/lib/auth/form-response";
import { parsePasswordRecoveryForm } from "@/lib/auth/form-fields";
import { requestPasswordRecoveryFlow } from "@/lib/auth/password-flow";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const requestForm = await readSameOriginAuthForm(request);
  if (requestForm.kind === "Rejected") {
    return requestForm.response;
  }

  const form = parsePasswordRecoveryForm(requestForm.formData);
  if (!form || !form.email.trim()) {
    return authFormFailure({
      body: { kind: "InvalidRequest" },
      status: 400,
    });
  }

  const auth = await createRouteHandlerClient();
  const outcome = await requestPasswordRecoveryFlow({
    supabase: auth.supabase,
    email: form.email,
  });

  switch (outcome.kind) {
    case "Requested": {
      await auth.settlePendingCookieWrites();
      return auth.applyCookies(
        NextResponse.redirect(new URL("/forgot-password?sent=1", requestForm.origin), {
          status: 303,
        }),
      );
    }
    case "RateLimited":
      return authFormFailure({ body: outcome, status: 429 });
    case "ServiceUnavailable":
      return authFormFailure({ body: outcome, status: 503 });
  }

  outcome satisfies never;
}
