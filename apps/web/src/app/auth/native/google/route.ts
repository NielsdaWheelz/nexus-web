import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { mintHandoffCode } from "@/lib/auth/internal";
import { abandoned, finish } from "@/lib/auth/session";
import { signInWithGoogleIdToken } from "@/lib/supabase/auth";
import { isRecord } from "@/lib/validation";

export const runtime = "nodejs";

// android credential manager's google id token -> a provider session -> a
// handoff code the webview consumes at /auth/handoff. the native http client
// keeps no session.
export async function POST(request: Request): Promise<NextResponse> {
  const fail = (error: string, status: number) =>
    NextResponse.json({ error }, { status });
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return finish(fail("invalid_request", 400));
  }
  const field = (key: string) =>
    isRecord(body) && typeof body[key] === "string" && body[key]
      ? body[key]
      : null;
  const idToken = field("idToken");
  const nonce = field("nonce");
  const challenge = field("hc");
  if (!idToken || !nonce || !challenge) {
    return finish(fail("invalid_request", 400));
  }

  const presented = (await cookies()).getAll();
  const { tokens, writes } = await signInWithGoogleIdToken(
    presented,
    idToken,
    nonce,
  );
  const cleared = abandoned(presented, writes);
  if (!tokens) return finish(fail("google_signin_failed", 401), cleared);
  try {
    const code = await mintHandoffCode(tokens, challenge);
    if (!code) return finish(fail("handoff_mint_failed", 502), cleared);
    return finish(NextResponse.json({ data: { code } }), cleared);
  } catch (error) {
    console.error("auth_native_google_defect", error);
    return finish(fail("internal_error", 500), cleared);
  }
}
