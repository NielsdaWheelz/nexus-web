import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { resolveCallbackRedirectOrigin } from "@/lib/auth/callback-origin";
import { finalizeSessionResponse } from "@/lib/auth/session-response";
import {
  getSupabaseAuthCookieNames,
  readSupabaseSessionCookie,
} from "@/lib/auth/session-cookie";
import { getEnv } from "@/lib/env";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const redirectOrigin = resolveCallbackRedirectOrigin(request);
  const requestCookies = (await cookies()).getAll();
  const cookieNames = getSupabaseAuthCookieNames(requestCookies);
  const session = readSupabaseSessionCookie(requestCookies);

  if (session.state === "active") {
    const { url, anonKey } = getEnv().supabase;
    try {
      const signOutResponse = await boundedAuthFetch(
        `${url.replace(/\/$/, "")}/auth/v1/logout?scope=local`,
        {
          method: "POST",
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${session.accessToken}`,
          },
        },
        "Supabase sign-out timed out",
      );
      if (
        !signOutResponse.ok &&
        ![401, 403, 404].includes(signOutResponse.status)
      ) {
        console.error("Supabase sign-out failed:", signOutResponse.status);
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      console.error("Supabase sign-out failed:", error);
    }
  }

  const response = NextResponse.redirect(`${redirectOrigin}/login`, {
    status: 302,
  });
  return finalizeSessionResponse(response, {
    kind: "Clear",
    cookieNames,
    feedback: false,
  });
}
