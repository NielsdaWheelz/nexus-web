import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  DEFAULT_AUTH_REDIRECT,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import { createClient } from "@/lib/supabase/server";

const REQUEST_PATH_HEADER = "x-nexus-request-path";
const AUTH_VERIFY_TIMEOUT_MS = 2_000;

export async function requireAuthenticatedUser() {
  const cookieStore = await cookies();
  const session = readSupabaseSessionCookie(cookieStore.getAll());
  if (!session.ok) {
    for (const name of session.cookieNames) {
      try {
        cookieStore.set(name, "", { maxAge: 0, path: "/" });
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        // justify-ignore-error: Server Components cannot always mutate cookies.
        // Middleware and route handlers clear the same invalid cookies when they
        // own the response.
      }
    }
    return await redirectToLogin();
  }

  const supabase = await createClient();

  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const {
      data: { user },
    } = await Promise.race([
      supabase.auth.getUser(session.accessToken),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Supabase Auth verification timed out")),
          AUTH_VERIFY_TIMEOUT_MS
        );
      }),
    ]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });

    if (user) {
      return;
    }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    console.error("Protected route auth check failed:", error);
  }

  for (const name of session.cookieNames) {
    try {
      cookieStore.set(name, "", { maxAge: 0, path: "/" });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      // justify-ignore-error: Server Components cannot always mutate cookies.
      // Redirecting closed is the required auth boundary.
    }
  }
  await redirectToLogin();
}

async function redirectToLogin(): Promise<never> {
  const requestPath =
    (await headers()).get(REQUEST_PATH_HEADER) ?? DEFAULT_AUTH_REDIRECT;
  const nextPath = normalizeAuthRedirect(requestPath, DEFAULT_AUTH_REDIRECT);
  redirect(`/login?next=${encodeURIComponent(nextPath)}`);
}
