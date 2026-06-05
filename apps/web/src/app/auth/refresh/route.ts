import {
  AUTH_ENDED_FEEDBACK_COOKIE,
  SESSION_ENDED_MESSAGE,
} from "@/lib/auth/messages";
import { noStore } from "@/lib/auth/no-store";
import {
  buildAuthReturnTargetUrl,
  buildLoginUrl,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import { refreshSession } from "@/lib/auth/refresh";
import { applyRotatedCookies } from "@/lib/auth/rotated-cookies";
import {
  clearSupabaseAuthCookies,
  getSupabaseAuthCookieNames,
} from "@/lib/auth/session-cookie";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TEMPORARY_REDIRECT = 307;
const NO_CONTENT = 204;
const UNAUTHORIZED = 401;

async function clearAuthCookies(response: NextResponse): Promise<void> {
  const cookieNames = getSupabaseAuthCookieNames((await cookies()).getAll());
  clearSupabaseAuthCookies(response, cookieNames);
}

function markSessionEnded(response: NextResponse): void {
  response.cookies.set(AUTH_ENDED_FEEDBACK_COOKIE, "1", {
    httpOnly: true,
    maxAge: 60,
    path: "/",
    sameSite: "lax",
  });
}

// Browser-redirect flow: refresh once, then land on the originally requested
// page on success or on /login on failure. Every path is terminal — it never
// redirects back into a state that re-evaluates as `refreshable`.
export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const target = parseAuthReturnTarget(requestUrl.searchParams.get("next"));

  const result = await refreshSession();

  if (result.status === "refreshed") {
    const response = NextResponse.redirect(
      buildAuthReturnTargetUrl(requestUrl.origin, target),
      { status: TEMPORARY_REDIRECT }
    );
    applyRotatedCookies(response, result.cookiesToSet);
    return noStore(response);
  }

  const loginUrl = buildLoginUrl(requestUrl.origin, target, {
    errorDescription: SESSION_ENDED_MESSAGE,
  });
  const response = NextResponse.redirect(loginUrl, {
    status: TEMPORARY_REDIRECT,
  });
  await clearAuthCookies(response);
  markSessionEnded(response);
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
