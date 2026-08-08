import { mintHandoffCode } from "@/lib/auth/mint-handoff-code";
import { finalizeSessionResponse } from "@/lib/auth/session-response";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Native Android Credential Manager produces a Google ID token; this route
// exchanges it for a Supabase session and mints a single-use handoff code so
// the WebView can pick up the session via /auth/handoff.
export async function POST(request: Request): Promise<NextResponse> {
  let auth: Awaited<ReturnType<typeof createRouteHandlerClient>> | undefined;
  const finish = (response: NextResponse): NextResponse =>
    auth
      ? auth.applyCookies(response)
      : finalizeSessionResponse(response, { kind: "Preserve" });

  try {
    const body = await request.json();
    const idToken = body?.idToken;
    const nonce = body?.nonce;
    const hc = body?.hc;
    if (
      typeof idToken !== "string" ||
      !idToken ||
      typeof nonce !== "string" ||
      !nonce ||
      typeof hc !== "string" ||
      !hc
    ) {
      return finish(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
    }

    auth = await createRouteHandlerClient();
    const { supabase } = auth;
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: "google",
      token: idToken,
      nonce,
    });
    await auth.settlePendingCookieWrites();

    if (error || !data.session) {
      return finish(NextResponse.json(
        { error: "google_signin_failed" },
        { status: 401 }
      ));
    }

    const mintResult = await mintHandoffCode({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      challenge: hc,
    });
    if ("error" in mintResult) {
      // justify-ignore-error: a timed-out, non-2xx, or malformed mint all
      // surface to the native caller as a single handoff_mint_failed.
      return finish(NextResponse.json(
        { error: "handoff_mint_failed" },
        { status: 502 }
      ));
    }

    return finish(
      NextResponse.json({ data: { code: mintResult.code } }, { status: 200 }),
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return finish(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}
