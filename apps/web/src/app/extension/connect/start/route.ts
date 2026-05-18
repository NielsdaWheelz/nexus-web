import { NextResponse } from "next/server";
import { buildLoginRedirectUrl } from "@/lib/auth/redirects";
import {
  parseCookieHeader,
  readSupabaseSessionCookie,
} from "@/lib/auth/session-cookie";

const EXTENSION_SESSION_DEADLINE_MS = 5_000;

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

  const requestId = crypto.randomUUID();
  const fastApiBaseUrl =
    process.env.FASTAPI_BASE_URL ||
    (process.env.NODE_ENV === "production" ? "" : "http://localhost:8000");
  const internalSecret = process.env.NEXUS_INTERNAL_SECRET || "";

  if (
    !fastApiBaseUrl ||
    (process.env.NODE_ENV === "production" && !internalSecret)
  ) {
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException("Extension session request timed out", "AbortError")
    );
  }, EXTENSION_SESSION_DEADLINE_MS);

  let response: Response;
  try {
    response = await fetch(`${fastApiBaseUrl}/auth/extension-sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Request-ID": requestId,
        ...(internalSecret ? { "X-Nexus-Internal": internalSecret } : {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // justify-ignore-error: a timed-out or failed extension-session request is
    // reported to the extension as session_failed, the same as a non-ok response.
    return sessionFailedRedirect();
  } finally {
    clearTimeout(timeoutId);
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
