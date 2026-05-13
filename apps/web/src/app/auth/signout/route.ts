import {
  getSupabaseAuthCookieNames,
  readSupabaseSessionCookie,
} from "@/lib/auth/session-cookie";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const SIGN_OUT_DEADLINE_MS = 5_000;

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const requestCookies = (await cookies()).getAll();
  const cookieNames = getSupabaseAuthCookieNames(requestCookies);
  const session = readSupabaseSessionCookie(requestCookies);

  if (session.ok && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("Supabase sign-out timed out", "AbortError"));
    }, SIGN_OUT_DEADLINE_MS);

    try {
      const signOutResponse = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")}/auth/v1/logout?scope=local`,
        {
          method: "POST",
          headers: {
            apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.accessToken}`,
          },
          signal: controller.signal,
        }
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
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const response = NextResponse.redirect(`${requestUrl.origin}/login`, {
    status: 302,
  });
  for (const name of cookieNames) {
    response.cookies.set(name, "", { maxAge: 0, path: "/" });
  }

  return response;
}
