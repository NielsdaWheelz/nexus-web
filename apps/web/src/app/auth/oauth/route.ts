import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ended,
  finish,
  liveSession,
  redirectTo,
  type Effect,
} from "@/lib/auth/session";
import {
  callbackPath,
  expectedAccountPath,
  parseHandoffContext,
  isOAuthProvider,
  loginPath,
  parseReturnTarget,
} from "@/lib/auth/urls";
import { getEnv } from "@/lib/env";
import { AuthUnavailable, startOAuth, verify } from "@/lib/supabase/auth";

export const runtime = "nodejs";

// the provider redirect, started on the server: sign-in (a browser, or the
// android custom tab with flow=handoff&hc) or link mode, which adds an
// identity to the live session and always returns to /settings/identities.
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const provider = params.get("provider");
  const mode = params.get("mode") === "link" ? "link" : "signin";
  const expected = params.get("expected_account_id");
  const target = parseReturnTarget(mode === "link" ? expectedAccountPath(expected ? "/account/identities" : "/settings/identities", expected) : params.get("next"));
  const handoff = parseHandoffContext(params.get("flow"), params.get("hc"));
  const failed = (effect?: Effect) =>
    finish(redirectTo(loginPath(target, "oauth_start_failed", handoff)), effect);
  if (!isOAuthProvider(provider) || ((params.has("flow") || params.has("hc")) && !handoff)) return failed();

  let jar = (await cookies()).getAll();
  let rotation: Effect = { kind: "Preserve" };
  if (mode === "link") {
    let live;
    try {
      live = await liveSession();
    } catch (error) {
      if (!(error instanceof AuthUnavailable)) throw error;
      return failed();
    }
    if (live.kind === "Ended") return failed(ended(live.cookieNames));
    if (live.kind === "Anonymous") return failed();
    if (expected) {
      try {
        const viewer = await verify(live.accessToken);
        if (viewer === "Rejected" || viewer.userId !== expected) return finish(redirectTo(target), { kind: "Write", writes: live.writes });
      } catch (error) {
        if (!(error instanceof AuthUnavailable)) throw error;
        return failed({ kind: "Write", writes: live.writes });
      }
    }
    jar = [...live.cookies];
    rotation = { kind: "Write", writes: live.writes };
  }
  const callback = expectedAccountPath(callbackPath(target, handoff ? { handoff: handoff.challenge } : undefined), expected);
  const { url, writes } = await startOAuth(
    jar,
    provider,
    mode,
    new URL(callback, getEnv().appPublicOrigin).toString(),
  );
  const effect: Effect = {
    kind: "Write",
    writes: [...(rotation.kind === "Write" ? rotation.writes : []), ...writes],
  };
  return url ? finish(NextResponse.redirect(url, 307), effect) : failed(effect);
}
