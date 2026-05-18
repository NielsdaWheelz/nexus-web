import { normalizeAuthRedirect } from "@/lib/auth/redirects";
import { refreshSession } from "@/lib/auth/refresh";
import { getSupabaseAuthCookieNames } from "@/lib/auth/session-cookie";
import { type CookieToSet } from "@/lib/supabase/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TEMPORARY_REDIRECT = 307;
const NO_CONTENT = 204;
const UNAUTHORIZED = 401;

// Shown on the /login redirect when a refresh fails — specific, not an opaque
// "session expired", per the cutover's forced-logout UX rule.
const SESSION_ENDED_MESSAGE = "Your session ended. Please sign in again.";

function applyRotatedCookies(
  response: NextResponse,
  cookiesToSet: CookieToSet[]
): void {
  for (const { name, value, options } of cookiesToSet) {
    response.cookies.set(name, value, options);
  }
}

async function clearAuthCookies(response: NextResponse): Promise<void> {
  const cookieNames = getSupabaseAuthCookieNames((await cookies()).getAll());
  for (const name of cookieNames) {
    response.cookies.set(name, "", { maxAge: 0, path: "/" });
  }
}

// A response that carries a rotated auth Set-Cookie must never be cached: a
// cached Set-Cookie would hand one user another user's session.
function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

// Browser-redirect flow: refresh once, then land on the originally requested
// page on success or on /login on failure. Every path is terminal — it never
// redirects back into a state that re-evaluates as `refreshable`.
export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const nextPath = normalizeAuthRedirect(requestUrl.searchParams.get("next"));

  const result = await refreshSession();

  if (result.status === "refreshed") {
    const response = NextResponse.redirect(
      new URL(nextPath, requestUrl.origin),
      { status: TEMPORARY_REDIRECT }
    );
    applyRotatedCookies(response, result.cookiesToSet);
    return noStore(response);
  }

  const loginUrl = new URL("/login", requestUrl.origin);
  loginUrl.searchParams.set("next", nextPath);
  loginUrl.searchParams.set("error_description", SESSION_ENDED_MESSAGE);
  const response = NextResponse.redirect(loginUrl, {
    status: TEMPORARY_REDIRECT,
  });
  await clearAuthCookies(response);
  return noStore(response);
}

// Proactive-client flow: refresh once and report the outcome as a status code,
// carrying the rotated cookies on success. No redirect — the client only needs
// the cookies and the result.
export async function POST(): Promise<NextResponse> {
  const result = await refreshSession();

  if (result.status === "refreshed") {
    const response = new NextResponse(null, { status: NO_CONTENT });
    applyRotatedCookies(response, result.cookiesToSet);
    return noStore(response);
  }

  const response = new NextResponse(null, { status: UNAUTHORIZED });
  await clearAuthCookies(response);
  return noStore(response);
}
