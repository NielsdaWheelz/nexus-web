import { NextResponse } from "next/server";
import {
  authFormFailure,
  readSameOriginAuthForm,
} from "@/lib/auth/form-response";
import { parsePasswordSignInForm } from "@/lib/auth/form-fields";
import { signInWithPasswordFlow } from "@/lib/auth/password-flow";
import {
  buildAuthReturnTargetUrl,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const requestForm = await readSameOriginAuthForm(request);
  if (requestForm.kind === "Rejected") {
    return requestForm.response;
  }

  const form = parsePasswordSignInForm(requestForm.formData);
  if (!form || !form.email.trim() || !form.password) {
    return authFormFailure({
      body: { kind: "InvalidRequest" },
      status: 400,
    });
  }

  const target = parseAuthReturnTarget(form.next);
  const auth = await createRouteHandlerClient();
  const outcome = await signInWithPasswordFlow({
    supabase: auth.supabase,
    email: form.email,
    password: form.password,
  });

  switch (outcome.kind) {
    case "SignedIn": {
      await auth.settlePendingCookieWrites();
      return auth.applyCookies(
        NextResponse.redirect(buildAuthReturnTargetUrl(requestForm.origin, target), {
          status: 303,
        }),
      );
    }
    case "InvalidCredentials":
      return authFormFailure({ body: outcome, status: 401 });
    case "RateLimited":
      return authFormFailure({ body: outcome, status: 429 });
    case "ServiceUnavailable":
      return authFormFailure({ body: outcome, status: 503 });
  }

  outcome satisfies never;
}
