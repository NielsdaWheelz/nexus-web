import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ended,
  finish,
  getVerification,
  isSameOrigin,
  type Effect,
} from "@/lib/auth/session";
import { AuthUnavailable, refresh } from "@/lib/supabase/auth";
import { authCookieNames } from "@/lib/supabase/cookie";

export const runtime = "nodejs";

// the one place a page's session is refreshed: 204 live (rotated when
// refreshed), 401 ended (cleared, with feedback) or anonymous, 503 provider
// unavailable (credentials kept, Retry-After 3), 403 cross-site.
export async function POST(request: Request): Promise<NextResponse> {
  const answer = (status: number, effect?: Effect) =>
    finish(new NextResponse(null, { status }), effect);
  if (
    !isSameOrigin(request) ||
    request.headers.get("x-nexus-session") !== "Resolve"
  ) {
    return answer(403);
  }
  try {
    const verification = await getVerification();
    if (verification.kind === "Verified") return answer(204);
    if (verification.kind === "Anonymous") return answer(401);
    if (verification.kind === "SessionEnded") {
      return answer(401, ended(verification.cookieNames));
    }
    const presented = (await cookies()).getAll();
    const refreshed = await refresh(presented);
    return refreshed.kind === "Refreshed"
      ? answer(204, { kind: "Write", writes: refreshed.writes })
      : answer(401, ended(authCookieNames(presented)));
  } catch (error) {
    if (!(error instanceof AuthUnavailable)) throw error;
    const unavailable = answer(503);
    unavailable.headers.set("Retry-After", "3");
    return unavailable;
  }
}
