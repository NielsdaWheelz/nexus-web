import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import { admitNativeRequest, nativeError } from "@/lib/native/server";
import { finish, isSameOrigin, liveSession, redirectTo } from "@/lib/auth/session";
import { revoke } from "@/lib/supabase/auth";
import { authCookieNames, readBearer } from "@/lib/supabase/cookie";

// revoke this browser's session at the provider (refreshing first when the
// access token is near expiry, so the refresh token dies too), then clear it
// here. the provider's answer never blocks sign-out: failures are logged.
export async function POST(request: Request): Promise<NextResponse> {
  const native = isAndroidShellUserAgent(request.headers.get("user-agent") ?? "");
  if (native) {
    const rejected = admitNativeRequest(request);
    if (rejected) return rejected;
    const bearer = readBearer((await cookies()).getAll());
    if (bearer) {
      try { await revoke(bearer); }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        console.error("auth_native_signout_revoke_failed", error);
      }
    }
    return finish(new NextResponse(null, { status: 204 }));
  }
  if (!isSameOrigin(request)) return nativeError(403, "E_FORBIDDEN", "Cross-origin request rejected");
  const names = authCookieNames((await cookies()).getAll());
  try {
    const live = await liveSession();
    if (live.kind === "Live") {
      names.push(...live.cookieNames);
      await revoke(live.accessToken);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error("auth_signout_revoke_failed", error);
  }
  return finish(redirectTo("/login", 302), {
    kind: "Clear",
    cookieNames: [...new Set(names)],
    feedback: false,
  });
}
