import { createRouteHandlerClient } from "@/lib/supabase/route-handler";
import { getSupabaseAuthCookieNames } from "@/lib/auth/session-cookie";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const cookieNames = getSupabaseAuthCookieNames((await cookies()).getAll());
  const { supabase, applyCookies } = await createRouteHandlerClient();

  // Local scope signs the current browser session out without revoking other devices.
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    console.error("Supabase sign-out failed:", error);
  }

  const response = NextResponse.redirect(`${requestUrl.origin}/login`, {
    status: 302,
  });
  for (const name of cookieNames) {
    response.cookies.set(name, "", { maxAge: 0, path: "/" });
  }

  return applyCookies(response);
}
