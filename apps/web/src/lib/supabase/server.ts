/**
 * Server-side Supabase client for Next.js route handlers and server components.
 *
 * This client uses cookies for session management and should only be used
 * on the server side (route handlers, server components, middleware).
 *
 * Security:
 * - Access tokens are never exposed to the browser
 * - Session is managed via HTTP-only cookies
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  SUPABASE_AUTH_COOKIE_OPTIONS,
  createSupabaseDeadlineFetch,
} from "./client-config";
import { type CookieToSet } from "./types";

/**
 * Create a Supabase client for server-side operations.
 *
 * Uses cookies for session management. The access token is extracted
 * from the session for forwarding to FastAPI.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: SUPABASE_AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
              cookieStore.set(name, value, options)
            );
          } catch (error) {
            if (!(error instanceof Error)) {
              throw error;
            }
            // justify-ignore-error: a Server Component cannot mutate cookies.
            // Middleware and route handlers that own the response refresh and
            // rotate the same session cookies, so the write is safely dropped
            // here.
          }
        },
      },
      global: {
        fetch: createSupabaseDeadlineFetch("Supabase auth operation timed out"),
      },
    }
  );
}
