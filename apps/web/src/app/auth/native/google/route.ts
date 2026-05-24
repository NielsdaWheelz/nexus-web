import {
  getInternalApiConfig,
  isInternalApiConfigured,
} from "@/lib/api/internal-config";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { createRandomId } from "@/lib/createRandomId";
import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Native Android Credential Manager produces a Google ID token; this route
// exchanges it for a Supabase session and mints a single-use handoff code so
// the WebView can pick up the session via /auth/handoff.
export async function POST(request: Request): Promise<NextResponse> {
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
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const config = getInternalApiConfig();
    if (!isInternalApiConfigured(config)) {
      return NextResponse.json({ error: "not_configured" }, { status: 500 });
    }

    const { supabase } = await createRouteHandlerClient();
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: "google",
      token: idToken,
      nonce,
    });

    if (error || !data.session) {
      return NextResponse.json(
        { error: "google_signin_failed" },
        { status: 401 }
      );
    }

    const requestId = createRandomId();

    let mintResponse: Response;
    try {
      mintResponse = await boundedAuthFetch(
        `${config.fastApiBaseUrl}/auth/handoff-codes`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${data.session.access_token}`,
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
            ...(config.internalSecret
              ? { "X-Nexus-Internal": config.internalSecret }
              : {}),
          },
          body: JSON.stringify({
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            challenge: hc,
          }),
        },
        "Handoff mint request timed out"
      );
    } catch (mintError) {
      if (!(mintError instanceof Error)) {
        throw mintError;
      }
      // justify-ignore-error: a timed-out or failed mint surfaces to the
      // native caller as handoff_mint_failed, the same as a non-2xx response.
      return NextResponse.json(
        { error: "handoff_mint_failed" },
        { status: 502 }
      );
    }

    if (!mintResponse.ok) {
      return NextResponse.json(
        { error: "handoff_mint_failed" },
        { status: 502 }
      );
    }

    const mintBody = await mintResponse.json();
    const code = mintBody?.data?.code;
    if (typeof code !== "string" || !code) {
      return NextResponse.json(
        { error: "handoff_mint_failed" },
        { status: 502 }
      );
    }

    return NextResponse.json({ data: { code } }, { status: 200 });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
