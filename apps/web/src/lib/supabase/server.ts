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

import { cookies } from "next/headers";
import { createSupabaseServerClient } from "./client-config";
import { type CookieToSet } from "./types";

/**
 * Create a writable Supabase client for response-owning server operations.
 *
 * Uses cookies for session management. The access token is extracted
 * from the session for forwarding to FastAPI.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createSupabaseServerClient(
    {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
          cookieStore.set(name, value, options),
        );
      },
    },
    "Supabase auth operation timed out",
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
  return createSupabaseServerClient(
    {
      getAll() {
        return cookieStore.getAll();
      },
      setAll() {
        throw new Error(
          "Server Component session verification attempted to mutate cookies",
        );
      },
    },
    "Supabase auth operation timed out",
  );
}
