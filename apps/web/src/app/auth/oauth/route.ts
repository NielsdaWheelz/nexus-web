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
  isOAuthProvider,
  loginPath,
  parseReturnTarget,
} from "@/lib/auth/urls";
import { getEnv } from "@/lib/env";
import { AuthUnavailable, startOAuth } from "@/lib/supabase/auth";

export const runtime = "nodejs";

// the provider redirect, started on the server: sign-in (a browser, or the
// android custom tab with flow=handoff&hc) or link mode, which adds an
// identity to the live session and always returns to /settings/identities.
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const provider = params.get("provider");
  const mode = params.get("mode") === "link" ? "link" : "signin";
  const target = parseReturnTarget(
    mode === "link" ? "/settings/identities" : params.get("next"),
  );
  const failed = (effect?: Effect) =>
    finish(redirectTo(loginPath(target, "oauth_start_failed")), effect);
  if (!isOAuthProvider(provider)) return failed();

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
    jar = [...live.cookies];
    rotation = { kind: "Write", writes: live.writes };
  }
  const hc = params.get("hc") ?? "";
  const callback = callbackPath(
    target,
    params.get("flow") === "handoff" ? { handoff: hc } : undefined,
  );
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
