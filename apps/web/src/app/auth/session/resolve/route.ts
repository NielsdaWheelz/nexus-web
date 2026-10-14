import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertNever } from "@/lib/assertNever";
import {
  ended,
  finish,
  isSameOrigin,
  resolveEntry,
  type Effect,
} from "@/lib/auth/session";
import { AuthUnavailable } from "@/lib/supabase/auth";

export const runtime = "nodejs";

// explicit retry only: entry navigation already resolves in middleware.
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
    const live = await resolveEntry((await cookies()).getAll());
    switch (live.kind) {
      case "Live":
        return answer(204, { kind: "Write", writes: live.writes });
      case "Anonymous":
        return answer(401);
      case "Ended":
        return answer(401, ended(live.cookieNames));
      default:
        return assertNever(live);
    }
  } catch (error) {
    if (error instanceof AuthUnavailable) {
      const unavailable = answer(503);
      unavailable.headers.set("Retry-After", "3");
      return unavailable;
    }
    console.error("Session resolution failed:", error);
    return answer(500);
  }
}
