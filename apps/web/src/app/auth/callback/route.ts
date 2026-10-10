import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { mintHandoffCode } from "@/lib/auth/internal";
import { abandoned, finish, redirectTo } from "@/lib/auth/session";
import { handoffDeepLink, loginPath, parseReturnTarget } from "@/lib/auth/urls";
import { exchangeCode } from "@/lib/supabase/auth";

export const runtime = "nodejs";

const DECLINED = new Set(["access_denied", "user_denied", "consent_required"]);

// the provider's return: an oauth sign-in or link, or an email-change
// confirmation. the browser flow installs the session and goes on to the
// target; the handoff flow mints a code for the android shell and deep-links
// back, leaving no session in the custom tab.
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const target = parseReturnTarget(params.get("next"));
  const flow = params.get("flow");
  const deepLink = (outcome: { code: string } | { error: string }) =>
    NextResponse.redirect(handoffDeepLink(outcome, target), 307);
  const failed = (handoffError: string, cancelled = false) =>
    flow === "handoff"
      ? deepLink({ error: cancelled ? "oauth_user_cancelled" : handoffError })
      : redirectTo(loginPath(target, cancelled ? undefined : "sign_in_failed"));

  if (params.has("error") || params.has("error_description")) {
    // a consent the viewer declined returns to /login silently. the provider
    // reports its own refusals (no invitation: signup_disabled) as
    // access_denied too, but with an error_code: those failed.
    const cancelled =
      DECLINED.has(params.get("error") ?? "") && !params.has("error_code");
    return finish(failed("oauth_provider_error", cancelled));
  }
  const code = params.get("code");
  if (!code) return finish(failed("oauth_callback_missing_code"));

  const presented = (await cookies()).getAll();
  const { tokens, writes } = await exchangeCode(presented, code);
  if (!tokens) {
    // the provider applies an email change before it redirects here; a
    // browser without this flow's pkce verifier just goes on to the target
    // (and signs in there).
    const outcome =
      flow === "email" ? redirectTo(target) : failed("handoff_exchange_failed");
    return finish(outcome, { kind: "Write", writes });
  }
  if (flow !== "handoff") {
    return finish(redirectTo(target), { kind: "Write", writes });
  }
  // the custom tab keeps no session: the webview installs it from the code.
  try {
    const minted = await mintHandoffCode(tokens, params.get("hc") ?? "");
    return finish(
      deepLink(minted ? { code: minted } : { error: "handoff_mint_failed" }),
      abandoned(presented, writes),
    );
  } catch (error) {
    console.error("auth_handoff_mint_defect", error);
    return finish(
      new NextResponse(null, { status: 500 }),
      abandoned(presented, writes),
    );
  }
}
