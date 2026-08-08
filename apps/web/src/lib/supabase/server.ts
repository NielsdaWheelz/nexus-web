/**
 * Writable server-side Supabase client for Next.js route handlers and server
 * actions.
 *
 * This client uses cookies for session management and should only be used
 * on the server side (route handlers and server actions).
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
 * Create a writable Supabase client for response-owning server operations.
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
          cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
            cookieStore.set(name, value, options)
          );
        },
      },
      global: {
        fetch: createSupabaseDeadlineFetch("Supabase auth operation timed out"),
      },
    }
  );
}

/**
 * Create the verifier client used by Server Components.
 *
 * Server Components may inspect and cryptographically verify the incoming
 * access token, but they do not own the response and therefore must never
 * refresh or mutate the session cookie jar. A cookie write is a contract
 * violation and fails loudly; the request-time resolver owns that transition.
 */
export async function createSessionVerifierClient() {
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
        setAll() {
          throw new Error(
            "Server Component session verification attempted to mutate cookies",
          );
        },
      },
      global: {
        fetch: createSupabaseDeadlineFetch("Supabase auth operation timed out"),
      },
    },
  );
}
