import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { internalAuthHeaders } from "@/lib/auth/internal-auth-headers";
import { buildLoginRedirectUrl } from "@/lib/auth/redirects";
import { createRandomId } from "@/lib/createRandomId";
import { parseWebOriginList } from "@/lib/security/origin";
import {
  parseCookieHeader,
  readSupabaseSessionCookie,
} from "@/lib/auth/session-cookie";

export async function GET(req: Request) {
  const requestUrl = new URL(req.url);
  const redirectUri = requestUrl.searchParams.get("redirect_uri");
  if (!redirectUri) {
    return NextResponse.json(
      { error: { code: "E_INVALID_REQUEST", message: "redirect_uri is required" } },
      { status: 400 }
    );
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectUri);
  } catch {
    return NextResponse.json(
      { error: { code: "E_INVALID_REQUEST", message: "redirect_uri is invalid" } },
      { status: 400 }
    );
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
    return NextResponse.json(
      { error: { code: "E_FORBIDDEN", message: "Extension redirect origin is not allowed" } },
      { status: 403 }
    );
  }

  const session = readSupabaseSessionCookie(
    parseCookieHeader(req.headers.get("cookie"))
  );
  if (session.state === "refreshable") {
    const refreshUrl = new URL("/auth/refresh", requestUrl.origin);
    refreshUrl.searchParams.set(
      "next",
      `${requestUrl.pathname}${requestUrl.search}`
    );
    return NextResponse.redirect(refreshUrl);
  }
  if (session.state === "ended" || session.state === "anonymous") {
    return NextResponse.redirect(buildLoginRedirectUrl(requestUrl));
  }
  session.state satisfies "active";

  const requestId = createRandomId();
  const { fastApiBaseUrl } = getEnv().internalApi;

  const sessionFailedRedirect = () => {
    redirectUrl.hash = new URLSearchParams({
      error: "session_failed",
      request_id: requestId,
    }).toString();
    return NextResponse.redirect(redirectUrl);
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
  return NextResponse.redirect(redirectUrl);
}
