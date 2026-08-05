import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionVerification } from "@/lib/auth/dal";
import {
  authFormFailure,
  readSameOriginAuthForm,
} from "@/lib/auth/form-response";
import { parsePasswordUpdateForm } from "@/lib/auth/form-fields";
import { SESSION_ENDED_MESSAGE } from "@/lib/auth/messages";
import { noStore } from "@/lib/auth/no-store";
import { updatePasswordFlow } from "@/lib/auth/password-flow";
import { refreshSession } from "@/lib/auth/refresh";
import {
  authReturnTargetToHref,
  buildLoginUrl,
  isDefaultAuthReturnTarget,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import { applyRotatedCookies } from "@/lib/auth/rotated-cookies";
import {
  clearSupabaseAuthCookies,
  getSupabaseAuthCookieNames,
} from "@/lib/auth/session-cookie";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import type { CookieToSet } from "@/lib/supabase/types";

export const runtime = "nodejs";

function buildPasswordSurfaceUrl(
  origin: string,
  target: ReturnType<typeof parseAuthReturnTarget>,
  saved: boolean,
): URL {
  const url = new URL("/account/password", origin);
  if (saved) {
    url.searchParams.set("saved", "1");
  }
  if (!isDefaultAuthReturnTarget(target)) {
    url.searchParams.set("next", authReturnTargetToHref(target));
  }
  return url;
}

function passwordSurfaceReturnTarget(
  origin: string,
  target: ReturnType<typeof parseAuthReturnTarget>,
): ReturnType<typeof parseAuthReturnTarget> {
  const url = buildPasswordSurfaceUrl(origin, target, false);
  return parseAuthReturnTarget(`${url.pathname}${url.search}`);
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestForm = await readSameOriginAuthForm(request);
  if (requestForm.kind === "Rejected") {
    return requestForm.response;
  }

  const form = parsePasswordUpdateForm(requestForm.formData);
  if (!form || !form.password) {
    return authFormFailure({
      body: { kind: "InvalidRequest" },
      status: 400,
    });
  }

  const target = parseAuthReturnTarget(form.next);
  const verification = await getSessionVerification();
  let rotatedCookies: CookieToSet[] = [];
  switch (verification.kind) {
    case "Verified":
      break;
    case "RefreshRequired": {
      // The password exists only in this POST body. Refresh inline so an
      // expired access token cannot redirect through GET and silently discard
      // the mutation the user just submitted.
      const refreshed = await refreshSession();
      if (refreshed.status === "failed") {
        if (refreshed.reason === "timeout") {
          return authFormFailure({
            body: { kind: "ServiceUnavailable" },
            status: 503,
          });
        }
        const response = noStore(
          NextResponse.redirect(
            buildLoginUrl(
              requestForm.origin,
              passwordSurfaceReturnTarget(requestForm.origin, target),
              { errorDescription: SESSION_ENDED_MESSAGE },
            ),
            { status: 303 },
          ),
        );
        const requestCookies = (await cookies()).getAll();
        clearSupabaseAuthCookies(
          response,
          getSupabaseAuthCookieNames(requestCookies),
        );
        return response;
      }
      rotatedCookies = refreshed.cookiesToSet;
      break;
    }
    case "SignInRequired": {
      const response = noStore(
        NextResponse.redirect(
          buildLoginUrl(
            requestForm.origin,
            passwordSurfaceReturnTarget(requestForm.origin, target),
            { errorDescription: SESSION_ENDED_MESSAGE },
          ),
          { status: 303 },
        ),
      );
      clearSupabaseAuthCookies(response, verification.cookieNames);
      return response;
    }
  }
  const auth = await createRouteHandlerClient();
  const outcome = await updatePasswordFlow({
    supabase: auth.supabase,
    password: form.password,
  });
  await auth.settlePendingCookieWrites();

  function applySessionCookies(response: NextResponse): NextResponse {
    // Refresh cookies establish the session used for this mutation. Any later
    // auth-state cookies emitted by updateUser win for the same cookie name.
    applyRotatedCookies(response, rotatedCookies);
    return auth.applyCookies(response);
  }

  switch (outcome.kind) {
    case "Saved": {
      const successUrl = buildPasswordSurfaceUrl(
        requestForm.origin,
        target,
        true,
      );
      return applySessionCookies(
        noStore(NextResponse.redirect(successUrl, { status: 303 })),
      );
    }
    case "PolicyRejected":
      return applySessionCookies(
        authFormFailure({ body: outcome, status: 400 }),
      );
    case "SessionEnded": {
      const response = noStore(
        NextResponse.redirect(
          buildLoginUrl(
            requestForm.origin,
            passwordSurfaceReturnTarget(requestForm.origin, target),
            { errorDescription: SESSION_ENDED_MESSAGE },
          ),
          { status: 303 },
        ),
      );
      const requestCookies = (await cookies()).getAll();
      clearSupabaseAuthCookies(
        response,
        getSupabaseAuthCookieNames(requestCookies),
      );
      return response;
    }
    case "RateLimited":
      return applySessionCookies(
        authFormFailure({ body: outcome, status: 429 }),
      );
    case "ServiceUnavailable":
      return applySessionCookies(
        authFormFailure({ body: outcome, status: 503 }),
      );
  }

  outcome satisfies never;
}
