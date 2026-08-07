import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { resolveCallbackRedirectOrigin } from "@/lib/auth/callback-origin";
import { getSessionVerification } from "@/lib/auth/dal";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { internalAuthHeaders } from "@/lib/auth/internal-auth-headers";
import {
  buildAuthSessionRecoveryUrl,
  buildLoginUrl,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import { createRandomId } from "@/lib/createRandomId";
import {
  AuthDependencyError,
  finalizeSessionResponse,
} from "@/lib/auth/session-response";
import { parseWebOriginList } from "@/lib/security/origin";
import {
  parseCookieHeader,
  readSupabaseSessionCookie,
} from "@/lib/auth/session-cookie";

function preserve(response: NextResponse): NextResponse {
  return finalizeSessionResponse(response, { kind: "Preserve" });
}

export async function GET(req: Request) {
  const requestUrl = new URL(req.url);
  const redirectOrigin = resolveCallbackRedirectOrigin(req);
  const redirectUri = requestUrl.searchParams.get("redirect_uri");
  if (!redirectUri) {
    return preserve(NextResponse.json(
      { error: { code: "E_INVALID_REQUEST", message: "redirect_uri is required" } },
      { status: 400 }
    ));
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectUri);
  } catch {
    return preserve(NextResponse.json(
      { error: { code: "E_INVALID_REQUEST", message: "redirect_uri is invalid" } },
      { status: 400 }
    ));
  }

  const parsedAllowedOrigins = parseWebOriginList(
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS
  );
  const allowedOrigins = parsedAllowedOrigins.origins.map((origin) => origin.origin);
  if (
    parsedAllowedOrigins.invalidValues.length > 0 ||
    redirectUrl.protocol !== "https:" ||
    !allowedOrigins.includes(redirectUrl.origin)
  ) {
    return preserve(NextResponse.json(
      { error: { code: "E_FORBIDDEN", message: "Extension redirect origin is not allowed" } },
      { status: 403 }
    ));
  }

  const returnTarget = parseAuthReturnTarget(
    `${requestUrl.pathname}${requestUrl.search}`,
  );

  const session = readSupabaseSessionCookie(
    parseCookieHeader(req.headers.get("cookie"))
  );
  if (session.state === "refreshable") {
    return preserve(NextResponse.redirect(
      buildAuthSessionRecoveryUrl(redirectOrigin, returnTarget)
    ));
  }
  if (session.state === "ended" || session.state === "anonymous") {
    return preserve(NextResponse.redirect(
      buildLoginUrl(redirectOrigin, returnTarget)
    ));
  }

  session.state satisfies "active";
  let verification: Awaited<ReturnType<typeof getSessionVerification>>;
  try {
    verification = await getSessionVerification();
  } catch (error) {
    if (!(error instanceof AuthDependencyError)) {
      throw error;
    }
    return preserve(NextResponse.redirect(
      buildAuthSessionRecoveryUrl(redirectOrigin, returnTarget),
    ));
  }

  switch (verification.kind) {
    case "Verified":
      break;
    case "RefreshRequired":
      return preserve(NextResponse.redirect(
        buildAuthSessionRecoveryUrl(redirectOrigin, returnTarget),
      ));
    case "SessionEnded":
    case "Anonymous":
      return preserve(NextResponse.redirect(
        buildLoginUrl(redirectOrigin, returnTarget),
      ));
  }

  const requestId = createRandomId();
  const { fastApiBaseUrl } = getEnv().internalApi;

  const sessionFailedRedirect = () => {
    redirectUrl.hash = new URLSearchParams({
      error: "session_failed",
      request_id: requestId,
    }).toString();
    return preserve(NextResponse.redirect(redirectUrl));
  };

  let response: Response;
  try {
    response = await boundedAuthFetch(
      `${fastApiBaseUrl}/auth/extension-sessions`,
      {
        method: "POST",
        headers: internalAuthHeaders({
          accessToken: session.accessToken,
          requestId,
        }),
      },
      "Extension session request timed out"
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // justify-ignore-error: a timed-out or failed extension-session request is
    // reported to the extension as session_failed, the same as a non-ok response.
    return sessionFailedRedirect();
  }

  if (!response.ok) {
    return sessionFailedRedirect();
  }

  const body = await response.json();
  const token = body?.data?.token;
  if (typeof token !== "string" || !token) {
    return sessionFailedRedirect();
  }

  redirectUrl.hash = new URLSearchParams({ token }).toString();
  return preserve(NextResponse.redirect(redirectUrl));
}
