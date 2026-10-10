import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { consumeHandoffCode } from "@/lib/auth/internal";
import { abandoned, finish, redirectTo } from "@/lib/auth/session";
import { loginPath, parseReturnTarget } from "@/lib/auth/urls";
import { installSession } from "@/lib/supabase/auth";

export const runtime = "nodejs";

// the android webview lands here after a custom-tab oauth or a native google
// sign-in: consume the code with the native-held verifier and install the
// session as this webview's own cookie.
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const target = parseReturnTarget(params.get("next"));
  const error = params.get("error");
  if (error === "oauth_user_cancelled") {
    return finish(redirectTo(loginPath(target)));
  }
  const failed = redirectTo(loginPath(target, "sign_in_failed"));
  const code = params.get("code");
  const verifier = params.get("hv");
  const tokens =
    !error && code && verifier
      ? await consumeHandoffCode(code, verifier)
      : null;
  if (!tokens) return finish(failed);

  const presented = (await cookies()).getAll();
  try {
    const installed = await installSession(presented, tokens);
    if (!installed.tokens) {
      return finish(failed, abandoned(presented, installed.writes));
    }
    return finish(redirectTo(target), {
      kind: "Write",
      writes: installed.writes,
    });
  } catch (cause) {
    console.error("auth_handoff_install_defect", cause);
    return finish(
      new NextResponse(null, { status: 500 }),
      abandoned(presented, []),
    );
  }
}
