import { OAUTH_START_FAILURE_MESSAGE } from "@/lib/auth/messages";
import { resolveCallbackRedirectOrigin } from "@/lib/auth/callback-origin";
import { type OAuthProvider } from "@/lib/auth/identities";
import {
  buildAuthCallbackUrl,
  buildLoginUrl,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TEMPORARY_REDIRECT = 307;

// Identity linking always returns to the identities pane; the requested-page
// `next` only applies to a fresh sign-in.
const IDENTITY_LINK_RETURN_TARGET = parseAuthReturnTarget("/settings/identities");

// The `provider` query param is untrusted browser input; accept only the two
// configured providers before handing it to the Supabase SDK.
function isSupportedProvider(value: string | null): value is OAuthProvider {
  return value === "google" || value === "github";
}

// OAuth initiation runs server-side: the route builds the @supabase/ssr server
// client, asks Supabase for the provider authorization URL, and redirects the
// browser there. The browser never holds a Supabase client or a token.
export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const provider = requestUrl.searchParams.get("provider");
  const mode = requestUrl.searchParams.get("mode") === "link" ? "link" : "signin";
  const isHandoff = requestUrl.searchParams.get("flow") === "handoff";
  const hc = requestUrl.searchParams.get("hc");
  const target =
    mode === "link"
      ? IDENTITY_LINK_RETURN_TARGET
      : parseAuthReturnTarget(requestUrl.searchParams.get("next"));

  const redirectOrigin = resolveCallbackRedirectOrigin(request, requestUrl);

  if (!isSupportedProvider(provider)) {
    return NextResponse.redirect(
      buildLoginUrl(redirectOrigin, target, {
        errorDescription: OAUTH_START_FAILURE_MESSAGE,
      }),
      { status: TEMPORARY_REDIRECT }
    );
  }

  const redirectTo = isHandoff
    ? buildAuthCallbackUrl(redirectOrigin, target, {
        flow: "handoff",
        challenge: hc ?? "",
      })
    : buildAuthCallbackUrl(redirectOrigin, target);

  const { supabase, applyCookies } = await createRouteHandlerClient();
  // signInWithOAuth and linkIdentity share the OAuth response shape
  // ({ data: { url }, error }); the URL is the provider authorization URL.
  const { data, error } =
    mode === "link"
      ? await supabase.auth.linkIdentity({ provider, options: { redirectTo } })
      : await supabase.auth.signInWithOAuth({
          provider,
          options: { redirectTo },
        });

  if (error || !data.url) {
    return applyCookies(
      NextResponse.redirect(
        buildLoginUrl(redirectOrigin, target, {
          errorDescription: OAUTH_START_FAILURE_MESSAGE,
        }),
        { status: TEMPORARY_REDIRECT }
      )
    );
  }

  // applyCookies carries the PKCE code-verifier cookie Supabase wrote during
  // signInWithOAuth onto the redirect, so /auth/callback can complete the
  // exchange.
  return applyCookies(
    NextResponse.redirect(data.url, { status: TEMPORARY_REDIRECT })
  );
}
