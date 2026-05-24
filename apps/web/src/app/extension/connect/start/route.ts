import { NextResponse } from "next/server";
import {
  getInternalApiConfig,
  isInternalApiConfigured,
} from "@/lib/api/internal-config";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { buildLoginRedirectUrl } from "@/lib/auth/redirects";
import { createRandomId } from "@/lib/createRandomId";
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

  const allowedOrigins = (process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (redirectUrl.protocol !== "https:" || !allowedOrigins.includes(redirectUrl.origin)) {
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
  const config = getInternalApiConfig();
  if (!isInternalApiConfigured(config)) {
    return NextResponse.json(
      {
        error: {
          code: "E_INTERNAL",
          message: "Backend service is not configured",
          request_id: requestId,
        },
      },
      { status: 500, headers: { "x-request-id": requestId } }
    );
  }

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
      `${config.fastApiBaseUrl}/auth/extension-sessions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "X-Request-ID": requestId,
          ...(config.internalSecret
            ? { "X-Nexus-Internal": config.internalSecret }
            : {}),
        },
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
