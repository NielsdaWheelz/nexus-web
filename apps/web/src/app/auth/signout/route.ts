import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { finish, liveSession, redirectTo } from "@/lib/auth/session";
import { revoke } from "@/lib/supabase/auth";
import { authCookieNames } from "@/lib/supabase/cookie";

// revoke this browser's session at the provider (refreshing first when the
// access token is near expiry, so the refresh token dies too), then clear it
// here. the provider's answer never blocks sign-out: failures are logged.
export async function POST(): Promise<NextResponse> {
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
