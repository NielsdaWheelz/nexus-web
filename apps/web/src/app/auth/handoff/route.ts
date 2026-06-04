import { getEnv } from "@/lib/env";
import { resolveCallbackRedirectOrigin } from "@/lib/auth/callback-origin";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { internalAuthHeaders } from "@/lib/auth/internal-auth-headers";
import { noStore } from "@/lib/auth/no-store";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
} from "@/lib/auth/messages";
import {
  buildLoginUrlWithError,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TEMPORARY_REDIRECT = 307;

// Error codes produced by `/auth/callback` in handoff mode.
// This route owns the public copy because no other surface renders it.
function publicErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case "oauth_user_cancelled":
      return AUTH_CALLBACK_CANCELLED_MESSAGE;
    case "oauth_provider_error":
    case "oauth_callback_missing_code":
    case "handoff_mint_failed":
    case "native_google_signin_failed":
      return AUTH_CALLBACK_FAILURE_MESSAGE;
    default:
      return AUTH_CALLBACK_FAILURE_MESSAGE;
  }
}

// The Custom Tab (Flow B) or the native Google controller (Flow C) lands the
// shell on this route after an OAuth handshake completed in an external
// user-agent. The route consumes the single-use handoff code against the
// native-held verifier, then `setSession`s the returned token pair so the
// WebView gets a first-party `HttpOnly` session cookie.
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("code");
    const hv = requestUrl.searchParams.get("hv");
    const errorCode = requestUrl.searchParams.get("error");
    const nextPath = normalizeAuthRedirect(requestUrl.searchParams.get("next"));
    const redirectOrigin = resolveCallbackRedirectOrigin(request, requestUrl);

    if (errorCode) {
      return noStore(
        NextResponse.redirect(
          buildLoginUrlWithError(
            redirectOrigin,
            nextPath,
            publicErrorMessage(errorCode)
          ),
          { status: TEMPORARY_REDIRECT }
        )
      );
    }

    if (!code || !hv) {
      return noStore(
        NextResponse.redirect(
          buildLoginUrlWithError(
            redirectOrigin,
            nextPath,
            AUTH_CALLBACK_FAILURE_MESSAGE
          ),
          { status: TEMPORARY_REDIRECT }
        )
      );
    }

    const { fastApiBaseUrl } = getEnv().internalApi;

    let consumeResponse: Response;
    try {
      consumeResponse = await boundedAuthFetch(
        `${fastApiBaseUrl}/auth/handoff-codes/consume`,
        {
          method: "POST",
          headers: internalAuthHeaders({ json: true }),
          body: JSON.stringify({ code, verifier: hv }),
        },
        "Handoff consume request timed out"
      );
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      // justify-ignore-error: a timed-out or failed handoff consume collapses
      // into the same public failure as a non-2xx response — by design, so the
      // route doesn't leak which of expired/used/wrong-verifier occurred.
      return noStore(
        NextResponse.redirect(
          buildLoginUrlWithError(
            redirectOrigin,
            nextPath,
            AUTH_CALLBACK_FAILURE_MESSAGE
          ),
          { status: TEMPORARY_REDIRECT }
        )
      );
    }

    if (!consumeResponse.ok) {
      return noStore(
        NextResponse.redirect(
          buildLoginUrlWithError(
            redirectOrigin,
            nextPath,
            AUTH_CALLBACK_FAILURE_MESSAGE
          ),
          { status: TEMPORARY_REDIRECT }
        )
      );
    }

    const body = await consumeResponse.json();
    const accessToken = body?.data?.access_token;
    const refreshToken = body?.data?.refresh_token;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      return noStore(
        NextResponse.redirect(
          buildLoginUrlWithError(
            redirectOrigin,
            nextPath,
            AUTH_CALLBACK_FAILURE_MESSAGE
          ),
          { status: TEMPORARY_REDIRECT }
        )
      );
    }

    const { supabase, applyCookies, settlePendingCookieWrites } =
      await createRouteHandlerClient();

    await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    await settlePendingCookieWrites();

    return applyCookies(
      noStore(
        NextResponse.redirect(new URL(nextPath, redirectOrigin), {
          status: TEMPORARY_REDIRECT,
        })
      )
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return noStore(
      new NextResponse(AUTH_CALLBACK_FAILURE_MESSAGE, { status: 500 })
    );
  }
}
