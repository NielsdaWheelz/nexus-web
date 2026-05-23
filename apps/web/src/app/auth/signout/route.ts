import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import {
  clearSupabaseAuthCookies,
  getSupabaseAuthCookieNames,
  readSupabaseSessionCookie,
} from "@/lib/auth/session-cookie";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const requestCookies = (await cookies()).getAll();
  const cookieNames = getSupabaseAuthCookieNames(requestCookies);
  const session = readSupabaseSessionCookie(requestCookies);

  if (
    session.state === "active" &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    try {
      const signOutResponse = await boundedAuthFetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")}/auth/v1/logout?scope=local`,
        {
          method: "POST",
          headers: {
            apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
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

  const response = NextResponse.redirect(`${requestUrl.origin}/login`, {
    status: 302,
  });
  clearSupabaseAuthCookies(response, cookieNames);

  return response;
}
